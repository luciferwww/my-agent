import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsActionResult } from '../core/settings/index.js';
import { restoreAgentConfigSection, saveAgentConfigSection } from '../platform/config/index.js';
import type { AgentConfigDocument } from '../platform/config/types.js';
import type { ExtensionAcquisitionResult } from '../extension/acquisition/types.js';
import type { RuntimeReloadResult } from './runtime-composition.js';
import { RuntimeDeadlineBudget, DEFAULT_RUNTIME_DEADLINE_POLICY, createSystemRuntimeDeadlineDriver, type RuntimeDeadlineDriver } from './runtime-deadline.js';
import { SettingsManager } from './settings-manager.js';
import { createBuiltinLlmProviderUnit, type BuiltinLlmProviderConfig } from '../builtins/providers/builtin/index.js';
import type { ModelInvocationPort, ModelInvocationResponse } from '../core/model-invocation/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type { RuntimeUnitInstance } from './runtime-unit.js';
import { CompositionCoordinator } from './composition-coordinator.js';
import { finalizeRegistrySnapshot, resolveStagedRegistryCandidate, stageRegistryUnit } from './registry-builder.js';

const model = { modelId: 'one', protocol: 'openai-responses' };
const settings = { builtin: { baseURL: 'https://updated.example/v1', models: [model] } };
const metadata: Pick<ExtensionAcquisitionResult, 'discovery' | 'diagnostics'> = {
  discovery: {
    candidates: ['relay', 'other'].map((id) => ({
      descriptor: {
        manifestVersion: 1, id, version: '1.0.0', entry: 'entry.js',
        configSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            label: { type: 'string', default: 'initial' },
            token: { type: 'string', writeOnly: true },
            hidden: { type: 'object', properties: { secret: { type: 'string', writeOnly: true } } },
          },
        },
      },
      installationPath: `C:\\installation\\${id}`,
      entryPath: `C:\\installation\\${id}\\entry.js`,
    })),
    diagnostics: [],
  },
  diagnostics: [{ category: 'disabled', code: 'extension_disabled', extensionId: 'other' }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected object.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function section(result: SettingsActionResult, id = 'llm'): Record<string, unknown> {
  const output = record(result.output);
  if (output['section']) return record(output['section']);
  if (!Array.isArray(output['sections'])) throw new Error('Expected sections.');
  const sectionId = id === 'llm' || id.startsWith('extension:') ? id : `extension:${id}`;
  return record(output['sections'].find((value: unknown) => record(value)['id'] === sectionId));
}

function revision(result: SettingsActionResult, id = 'llm'): string {
  const value = section(result, id)['revision'];
  if (typeof value !== 'string') throw new Error('Expected revision.');
  return value;
}

function rejected(): RuntimeReloadResult {
  return {
    requestId: 'reload', change: { operation: 'configure-llm', unitId: 'builtin-llm-provider' },
    warnings: [], outcome: 'rejected', generation: 1, category: 'preparation_failed', message: 'Rejected.',
  };
}

function modelResponse(): ModelInvocationResponse {
  return {
    content: [{ type: 'text', text: 'private-upstream-body' }], toolCalls: [],
    stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function testUnit(chat: ModelInvocationPort['chat'], stop: RuntimeUnitInstance['stop'] = vi.fn()) {
  const factory = vi.fn((config: BuiltinLlmProviderConfig) => {
    const unit = createBuiltinLlmProviderUnit(config, {
      createClient: () => ({ chat, chatStream: () => { throw new Error('Unexpected stream.'); } }),
    });
    return {
      ...unit,
      create: async (signal: AbortSignal) => ({ ...await unit.create(signal), stop }),
    };
  });
  return { factory, stop };
}

function publishProvider(coordinator: CompositionCoordinator, chat: ModelInvocationPort['chat'], generation = 1) {
  const provider: ProviderProjectionEntry = {
    id: 'relay', protocol: 'test', models: [{ modelId: 'one' }],
    invocationPort: { chat, chatStream: () => { throw new Error('Unexpected stream.'); } },
    resolveConnection: () => ({ ok: true, connection: { endpointId: 'loaded-connection' } }),
    resolveModel: (modelId, connection) => ({
      ok: true, descriptor: {
        identity: { providerId: 'relay', modelId }, protocol: 'test', connection,
        facts: { effectiveContextLimit: 4096 },
      },
    }),
  };
  coordinator.commitPublish(finalizeRegistrySnapshot({
    candidate: { providers: [provider], units: [], diagnostics: [] },
    acceptedUnits: [], channelBindings: [], generation,
  }));
}

describe('SettingsManager', () => {
  let agentHome: string;
  let document: AgentConfigDocument;
  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'settings-manager-'));
    document = {
      llm: { builtin: { ...settings.builtin, apiKey: '${SAVED_KEY}' } },
      extensions: { entries: {
        relay: { config: { label: 'initial', token: 'private-secret', hidden: { secret: 'nested-secret' } } },
        other: { enabled: false, config: {} },
      } },
    };
    await write(document);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(agentHome, { recursive: true, force: true });
  });

  async function write(value: AgentConfigDocument) {
    await writeFile(join(agentHome, 'config.json'), JSON.stringify(value), 'utf8');
  }
  async function read() {
    return JSON.parse(await readFile(join(agentHome, 'config.json'), 'utf8'));
  }
  function fixture(overrides: Partial<ConstructorParameters<typeof SettingsManager>[0]> = {}) {
    const apply = vi.fn(async (): Promise<RuntimeReloadResult> => ({
      requestId: 'reload', change: { operation: 'configure-llm', unitId: 'builtin-llm-provider' },
      warnings: [], outcome: 'published', previousGeneration: 1, generation: 2, retiredUnitIds: [],
    }));
    const save = vi.fn(saveAgentConfigSection);
    const restore = vi.fn(restoreAgentConfigSection);
    const manager = new SettingsManager({
      agentHome, document, environment: { SAVED_KEY: 'runtime-secret' }, extensionMetadata: metadata,
      getModelCatalog: () => ({ generation: 1, defaultSelection: { state: 'unset' }, providers: [] }),
      applyLlmConfiguration: apply, saveSection: save, restoreSection: restore, ...overrides,
    });
    const load = () => manager.execute({ requestId: 'load', action: 'load', input: {} });
    const update = (expectedRevision: string, value: unknown = settings, sectionId = 'llm', credentials?: unknown) =>
      manager.execute({ requestId: 'update', action: 'update', input: { sectionId, expectedRevision, settings: value, credentials } });
    return { manager, apply, save, restore, load, update };
  }

  it('loads safe saved views with stable revisions, credentials metadata and existing diagnostics', async () => {
    const f = fixture();
    const loaded = await f.load();
    const serialized = JSON.stringify(loaded);
    for (const secret of ['SAVED_KEY', 'runtime-secret', 'private-secret', 'nested-secret']) {
      expect(serialized).not.toContain(secret);
    }
    expect(section(loaded)).toMatchObject({ form: { credentials: { '/builtin/apiKey': { configured: true, source: 'environment' } } } });
    expect(section(loaded, 'other')).toMatchObject({ diagnostics: metadata.diagnostics });
    expect(loaded).toMatchObject({ output: { diagnostics: metadata.diagnostics } });
    expect(revision(await f.load())).toBe(revision(loaded));
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(await f.manager.execute({ requestId: 'unknown', action: 'unknown', input: {} }))
      .toMatchObject({ ok: false, error: { code: 'unsupported_action' } });
  });

  it('loads safe Tool names and descriptions from the current registry without filtering denied Tools', async () => {
    document = { ...document, agents: { defaults: { tools: { deny: ['exec'] } } } };
    await write(document);
    const coordinator = new CompositionCoordinator();
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [stageRegistryUnit({
        id: 'catalog-tools', source: 'builtin', orderKey: 'catalog-tools',
        register(api) {
          for (const name of ['read_file', 'exec']) api.registerTool({
            name, description: `${name} description`,
            inputSchema: { type: 'object', properties: { privateSchemaField: { type: 'string' } } },
            execute: async () => ({ outcome: 'success', content: '' }),
          });
        },
      })],
    });
    coordinator.commitPublish(finalizeRegistrySnapshot({
      candidate, acceptedUnits: candidate.units, channelBindings: [], generation: 1,
    }));
    const f = fixture({ snapshotAccess: coordinator.createSnapshotAccess() });
    expect(record((await f.load()).output)['toolCatalog']).toEqual([
      { name: 'read_file', description: 'read_file description' },
      { name: 'exec', description: 'exec description' },
    ]);
    expect(record((await fixture().load()).output)['toolCatalog']).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('treats an absent Extension entry as enabled and compares restart state against that default', async () => {
    document = {};
    await write(document);
    const f = fixture();
    const initial = await f.load();
    expect(section(initial, 'relay')).toMatchObject({ settings: { enabled: true }, restartRequired: false });
    const unchanged = await f.update(revision(initial, 'relay'), { enabled: true, config: { label: 'initial' } }, 'extension:relay');
    expect(section(unchanged, 'relay')).toMatchObject({ restartRequired: false });
    const disabled = await f.update(revision(unchanged, 'relay'), { enabled: false, config: {} }, 'extension:relay');
    expect(section(disabled, 'relay')).toMatchObject({ settings: { enabled: false }, restartRequired: true });
    const restored = await f.update(revision(disabled, 'relay'), { enabled: true, config: { label: 'initial' } }, 'extension:relay');
    expect(section(restored, 'relay')).toMatchObject({ settings: { enabled: true }, restartRequired: false });
  });

  it('saves then applies materialized LLM input and rejects stale revisions without another write', async () => {
    const f = fixture();
    const initial = revision(await f.load());
    const saved = await f.update(initial);
    expect(saved).toMatchObject({ ok: true, output: { section: { applicationStatus: 'current' } } });
    expect(revision(saved)).not.toBe(initial);
    expect(f.apply).toHaveBeenCalledWith({ builtin: { ...settings.builtin, apiKey: 'runtime-secret' } });
    expect((await read()).llm.builtin.apiKey).toBe('${SAVED_KEY}');
    expect(await f.update(initial)).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(f.save).toHaveBeenCalledOnce();
  });

  it('links Settings catalog Providers to their actual discovered configuration sections', async () => {
    let active = true;
    const f = fixture({
      getModelCatalog: () => ({
        generation: active ? 1 : 2, defaultSelection: { state: 'unset' },
        providers: (active ? ['builtin', 'provider-one', 'provider-two', 'other', 'embedded'] : ['builtin'])
          .map((providerId) => ({ providerId, displayName: providerId, models: [] })),
      }),
      getProviderUnitId: (providerId) => {
        if (['provider-one', 'provider-two'].includes(providerId)) return 'relay';
        if (providerId === 'other') return 'uninstalled-unit';
        return undefined;
      },
    });
    expect(await f.load()).toMatchObject({ output: { modelCatalog: { providers: [
      { providerId: 'builtin', configurationSectionId: 'llm' },
      { providerId: 'provider-one', configurationSectionId: 'extension:relay' },
      { providerId: 'provider-two', configurationSectionId: 'extension:relay' },
      { providerId: 'other' },
      { providerId: 'embedded' },
    ] } } });
    const output = record((await f.load()).output);
    const catalog = record(output['modelCatalog']);
    if (!Array.isArray(catalog['providers'])) throw new Error('Expected providers.');
    expect(catalog['providers'].slice(3).every((provider: unknown) =>
      !Object.hasOwn(record(provider), 'configurationSectionId'))).toBe(true);
    const saved = await f.update(revision(await f.load()));
    expect(saved).toMatchObject({ output: { modelCatalog: { providers: expect.arrayContaining([
      expect.objectContaining({ providerId: 'provider-one', configurationSectionId: 'extension:relay' }),
    ]) } } });
    active = false;
    expect(record(record((await f.load()).output)['modelCatalog'])['providers']).toEqual([
      { providerId: 'builtin', displayName: 'builtin', models: [], configurationSectionId: 'llm' },
    ]);
  });

  it('checks default-model facts before file commit without blocking Extension edits', async () => {
    const f = fixture();
    const initial = await f.load();
    expect(await f.update(revision(initial), { ...settings, defaultModel: { providerId: 'missing', modelId: 'missing' } }))
      .toMatchObject({ ok: false, error: { code: 'validation_failed', fieldPath: '/settings/defaultModel' } });
    expect(await read()).toEqual(document);
    expect(await f.update(revision(initial, 'relay'), { enabled: false, config: { label: 'initial' } }, 'extension:relay'))
      .toMatchObject({ ok: true });
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('restores original LLM absence when post-write materialization fails and returns a fresh revision', async () => {
    document = {};
    await write(document);
    const f = fixture({ environment: {} });
    const initial = revision(await f.load());
    const result = await f.update(initial, settings, 'llm', { '/builtin/apiKey': { operation: 'replace', value: '${UNAVAILABLE_KEY}' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'application_failed_rolled_back' }, output: { rollback: 'completed', section: { settings: {} } } });
    expect(revision(result)).not.toBe(initial);
    expect(await read()).toEqual({});
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('serializes application and rollback with queued updates and load, never exposing the candidate as completed', async () => {
    const application = deferred<RuntimeReloadResult>();
    const entered = deferred<void>();
    const rollback = deferred<void>();
    const restoring = deferred<void>();
    const f = fixture({
      applyLlmConfiguration: async () => { entered.resolve(); return application.promise; },
      restoreSection: async (...args) => { restoring.resolve(); await rollback.promise; return restoreAgentConfigSection(...args); },
    });
    const initial = revision(await f.load());
    const updating = f.update(initial);
    await entered.promise;
    let loaded = false;
    const loading = f.load().then((result) => { loaded = true; return result; });
    const queued = f.update(initial);
    application.resolve(rejected());
    await restoring.promise;
    expect(loaded).toBe(false);
    expect(f.save).toHaveBeenCalledOnce();
    rollback.resolve();
    const result = await updating;
    expect(result).toMatchObject({ ok: false, error: { code: 'application_failed_rolled_back' } });
    expect(revision(await loading)).toBe(revision(result));
    expect(await queued).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(await read()).toEqual(document);
  });

  it('allows later updates after rollback failure and restores only the later request preimage', async () => {
    const restoring = vi.fn(restoreAgentConfigSection).mockRejectedValueOnce(new Error('private-error-content'));
    const f = fixture({ applyLlmConfiguration: async () => rejected(), restoreSection: restoring });
    const failed = await f.update(revision(await f.load()));
    expect(failed).toMatchObject({ ok: false, error: { code: 'rollback_failed' }, output: { fileState: 'unknown' } });
    expect(JSON.stringify(failed)).not.toContain('private-error-content');
    expect(await f.load()).toMatchObject({ ok: false, error: { code: 'file_state_unknown' } });
    const previous = await read();
    const nextRevision = record(failed.output)['revision'];
    if (typeof nextRevision !== 'string') throw new Error('Expected current revision.');
    const next = await f.update(nextRevision, { builtin: { ...settings.builtin, baseURL: 'https://later.example/v1' } });
    expect(next).toMatchObject({ ok: false, error: { code: 'application_failed_rolled_back' } });
    expect(await read()).toEqual(previous);
    expect(await f.load()).toMatchObject({ ok: true, output: { sections: expect.arrayContaining([expect.objectContaining({ applicationStatus: 'not_applied' })]) } });
  });

  it('never rolls back published updates with retirement warnings or an unknown publication outcome', async () => {
    const f = fixture();
    f.apply.mockResolvedValueOnce({
      requestId: 'reload', change: { operation: 'configure-llm', unitId: 'builtin-llm-provider' },
      outcome: 'published', generation: 2, previousGeneration: 1, retiredUnitIds: [],
      warnings: [{ code: 'retirement_failed', message: 'Retirement failed.' }],
    });
    const saved = await f.update(revision(await f.load()));
    expect(saved).toMatchObject({ ok: true, output: { warnings: [{ code: 'retirement_failed' }] } });
    f.apply.mockRejectedValueOnce(new Error('unknown-private-publication-error'));
    const unknown = await f.update(revision(saved));
    expect(unknown).toMatchObject({ ok: false, error: { code: 'application_state_unknown' }, output: { rollback: 'not_attempted' } });
    expect(f.restore).not.toHaveBeenCalled();
    expect(JSON.stringify(unknown)).not.toContain('unknown-private-publication-error');
  });

  it('clears only the reverted Extension restart difference and retains kept raw credentials', async () => {
    const f = fixture();
    const initial = await f.load();
    const changed = await f.update(revision(initial, 'relay'), { enabled: true, config: { label: 'changed' } }, 'extension:relay');
    expect(section(changed)).toMatchObject({ restartRequired: true });
    const other = await f.update(revision(initial, 'other'), { enabled: true, config: {} }, 'extension:other');
    expect(section(other)).toMatchObject({ restartRequired: true });
    const reverted = await f.update(revision(changed), { enabled: true, config: { label: 'initial' } }, 'extension:relay');
    expect(section(reverted)).toMatchObject({ restartRequired: false });
    expect(section(await f.load(), 'other')).toMatchObject({ restartRequired: true });
    expect((await read()).extensions.entries.relay.config.token).toBe('private-secret');
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('cancels queued and preparing updates on shutdown before any file commit', async () => {
    const preparing = deferred<void>();
    const entered = deferred<void>();
    const f = fixture({
      saveSection: async (...args) => { entered.resolve(); await preparing.promise; return saveAgentConfigSection(...args); },
    });
    const initial = revision(await f.load());
    const active = f.update(initial);
    await entered.promise;
    const queued = f.update(initial);
    const budget = new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY);
    f.manager.beginShutdown(budget);
    expect(await queued).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(await f.update(initial)).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    preparing.resolve();
    expect(await active).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(await f.manager.shutdown(budget)).toEqual({ failed: [], residuals: [] });
    expect(await read()).toEqual(document);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('rolls back an admitted file commit after shutdown instead of starting Runtime application', async () => {
    const written = deferred<void>();
    const deliver = deferred<void>();
    const f = fixture({
      saveSection: async (...args) => {
        const result = await saveAgentConfigSection(...args);
        written.resolve(); await deliver.promise; return result;
      },
    });
    const updating = f.update(revision(await f.load()));
    await written.promise;
    const budget = new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY);
    f.manager.beginShutdown(budget);
    deliver.resolve();
    expect(await updating).toMatchObject({ ok: false, output: { rollback: 'completed' } });
    expect(await f.manager.shutdown(budget)).toEqual({ failed: [], residuals: [] });
    expect(f.apply).not.toHaveBeenCalled();
    expect(await read()).toEqual(document);
  });

  it('reports nonconvergent file work under the shared shutdown deadline without pretending it was cancelled', async () => {
    vi.useFakeTimers();
    const application = deferred<RuntimeReloadResult>();
    const entered = deferred<void>();
    const f = fixture({ applyLlmConfiguration: async () => { entered.resolve(); return application.promise; } });
    const updating = f.update(revision(await f.load()));
    await entered.promise;
    let now = 0;
    const system = createSystemRuntimeDeadlineDriver();
    const driver: RuntimeDeadlineDriver = {
      now: () => now,
      race: (operation, deadline) => system.race(operation, system.now() + Math.max(0, deadline - now)),
    };
    const budget = new RuntimeDeadlineBudget(driver, { ...DEFAULT_RUNTIME_DEADLINE_POLICY, shutdownOverallMs: 20 });
    const closing = f.manager.shutdown(budget);
    now = 20;
    await vi.advanceTimersByTimeAsync(20);
    expect(await closing).toEqual({
      failed: [], residuals: [expect.objectContaining({ owner: 'resource', phase: 'settings-applying' })],
    });
    application.resolve(rejected());
    expect(await updating).toMatchObject({ ok: false, error: { code: 'rollback_deadline_exhausted' } });
  });

  it('tests an unsaved Built-in draft with explicit credential intents without changing saved or Runtime state', async () => {
    const chat = vi.fn<ModelInvocationPort['chat']>(async () => modelResponse());
    const unit = testUnit(chat);
    const f = fixture({ createBuiltinProviderUnit: unit.factory });
    const loaded = await f.load();
    const candidate = { settings: settings.builtin, expectedRevision: revision(loaded) };
    const test = (builtin: unknown) => f.manager.execute({
      requestId: 'draft-test', action: 'test_llm_model', input: { reference: { providerId: 'builtin', modelId: 'one' }, builtin },
    });
    expect(await test({ ...candidate, expectedRevision: 'stale' }))
      .toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(unit.factory).not.toHaveBeenCalled();
    const result = await test(candidate);
    expect(result).toMatchObject({ ok: true, output: { reference: { providerId: 'builtin', modelId: 'one' }, outcome: 'completed' } });
    expect(unit.factory.mock.calls[0]?.[0]).toMatchObject({ apiKey: 'runtime-secret' });
    expect(chat.mock.calls[0]).toEqual([expect.objectContaining({
      model: 'one', messages: [{ role: 'user', content: 'Reply with OK.' }],
      outputTokenLimit: 64, signal: expect.any(AbortSignal),
    })]);
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
    expect(JSON.stringify(result)).not.toContain('private-upstream-body');
    expect(await test({ ...candidate, expectedRevision: 'stale', credentials: { '/builtin/apiKey': { operation: 'replace', value: '${SAVED_KEY}' } } }))
      .toMatchObject({ ok: true });
    expect(await test({ ...candidate, expectedRevision: 'stale', credentials: { '/builtin/apiKey': { operation: 'clear' } } }))
      .toMatchObject({ ok: true });
    expect(unit.factory.mock.calls[2]?.[0]).not.toHaveProperty('apiKey');
    const missing = await test({ ...candidate, credentials: { '/builtin/apiKey': { operation: 'replace', value: '${PRIVATE_MISSING_KEY}' } } });
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing)).not.toContain('PRIVATE_MISSING_KEY');
    expect(chat).toHaveBeenCalledTimes(3);
    expect(unit.stop).toHaveBeenCalledTimes(3);
    expect(revision(await f.load())).toBe(revision(loaded));
    expect(await read()).toEqual(document);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('tests the loaded Extension generation, rejecting candidate settings and retaining its pin across publication', async () => {
    const call = deferred<ModelInvocationResponse>();
    const entered = deferred<void>();
    const oldChat = vi.fn(async () => { entered.resolve(); return call.promise; });
    const currentChat = vi.fn(async () => modelResponse());
    const coordinator = new CompositionCoordinator();
    publishProvider(coordinator, oldChat);
    const f = fixture({ snapshotAccess: coordinator.createSnapshotAccess() });
    const request = { requestId: 'loaded-test', action: 'test_llm_model', input: { reference: { providerId: 'relay', modelId: 'one' } } };
    expect(await f.manager.execute({ ...request, input: { ...request.input, builtin: {} } }))
      .toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    const running = f.manager.execute(request);
    await entered.promise;
    expect(coordinator.pinCount(1)).toBe(1);
    publishProvider(coordinator, currentChat, 2);
    expect(coordinator.pinCount(1)).toBe(1);
    expect(currentChat).not.toHaveBeenCalled();
    call.resolve(modelResponse());
    expect(await running).toMatchObject({ ok: true });
    expect(coordinator.pinCount(1)).toBe(0);
    expect(await f.manager.execute(request)).toMatchObject({ ok: true });
    expect(currentChat).toHaveBeenCalledOnce();
    expect(coordinator.pinCount(2)).toBe(0);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('aborts cooperative loaded Tests at shutdown and releases pins before shutdown completes', async () => {
    const entered = deferred<void>();
    const chat = vi.fn<ModelInvocationPort['chat']>((request) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(new Error('private-abort-error')), { once: true });
      entered.resolve();
    }));
    const coordinator = new CompositionCoordinator();
    publishProvider(coordinator, chat);
    const f = fixture({ snapshotAccess: coordinator.createSnapshotAccess() });
    const request = { requestId: 'shutdown-test', action: 'test_llm_model', input: { reference: { providerId: 'relay', modelId: 'one' } } };
    const running = f.manager.execute(request);
    await entered.promise;
    const closing = f.manager.shutdown(new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY));
    expect(await running).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(await closing).toEqual({ failed: [], residuals: [] });
    expect(coordinator.pinCount(1)).toBe(0);
    expect(await f.manager.execute(request)).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(chat).toHaveBeenCalledOnce();
  });

  it('aborts Tests immediately while an update shares the remaining shutdown budget', async () => {
    vi.useFakeTimers();
    const application = deferred<RuntimeReloadResult>();
    const updatingEntered = deferred<void>();
    const invocation = deferred<ModelInvocationResponse>();
    const testEntered = deferred<void>();
    const chat = vi.fn<ModelInvocationPort['chat']>(async () => {
      testEntered.resolve();
      return invocation.promise;
    });
    const unit = testUnit(chat);
    const f = fixture({
      createBuiltinProviderUnit: unit.factory,
      applyLlmConfiguration: async () => { updatingEntered.resolve(); return application.promise; },
    });
    const initial = revision(await f.load());
    const testing = f.manager.execute({
      requestId: 'mixed-test', action: 'test_llm_model',
      input: { reference: { providerId: 'builtin', modelId: 'one' }, builtin: { settings: settings.builtin, expectedRevision: initial } },
    });
    await testEntered.promise;
    const updating = f.update(initial);
    await updatingEntered.promise;
    const driver = createSystemRuntimeDeadlineDriver();
    const budget = new RuntimeDeadlineBudget(driver, { ...DEFAULT_RUNTIME_DEADLINE_POLICY, shutdownOverallMs: 20 });
    const closing = f.manager.shutdown(budget);
    expect(await testing).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(chat.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(unit.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(await closing).toMatchObject({
      failed: [], residuals: [
        { requestId: 'update', phase: 'settings-applying' },
        { requestId: 'mixed-test', phase: 'settings-test-invoking' },
      ],
    });
    application.resolve({
      requestId: 'reload', change: { operation: 'configure-llm', unitId: 'builtin-llm-provider' },
      warnings: [], outcome: 'published', previousGeneration: 1, generation: 2, retiredUnitIds: [],
    });
    expect(await updating).toMatchObject({ ok: true });
    invocation.resolve(modelResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(unit.stop).toHaveBeenCalledOnce();
    expect(await f.manager.shutdown(budget)).toEqual({ failed: [], residuals: [] });
  });
  it('reports temporary cleanup failures to the caller and shutdown without blocking subsequent updates', async () => {
    const unit = testUnit(async () => modelResponse(), vi.fn(async () => { throw new Error('private-stop-error'); }));
    const f = fixture({ createBuiltinProviderUnit: unit.factory });
    const initial = revision(await f.load());
    const result = await f.manager.execute({
      requestId: 'cleanup-test', action: 'test_llm_model',
      input: { reference: { providerId: 'builtin', modelId: 'one' }, builtin: { settings: settings.builtin, expectedRevision: initial } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'test_cleanup_failed' } });
    expect(JSON.stringify(result)).not.toContain('private-stop-error');
    expect(await f.update(initial)).toMatchObject({ ok: true });
    expect(await f.manager.shutdown(new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY)))
      .toMatchObject({ failed: [{ resource: 'settings-test:cleanup-test' }], residuals: [] });
  });
});
