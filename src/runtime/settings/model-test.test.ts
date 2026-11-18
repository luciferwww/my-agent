import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsActionRequest } from '../../core/settings/index.js';
import { ModelInvocationError } from '../../core/model-invocation/index.js';
import type { ModelInvocationPort, ModelInvocationResponse } from '../../core/model-invocation/index.js';
import type { ProviderProjectionEntry } from '../../core/model-resolution/index.js';
import { createBuiltinLlmProviderUnit } from '../../builtins/providers/builtin/index.js';
import type { BuiltinLlmProviderConfig } from '../../builtins/providers/builtin/index.js';
import type { AgentConfigDocument } from '../../platform/config/types.js';
import { CompositionCoordinator } from '../composition/composition-coordinator.js';
import { finalizeRegistrySnapshot } from '../composition/registry-builder.js';
import { DEFAULT_RUNTIME_DEADLINE_POLICY, RuntimeDeadlineBudget, createSystemRuntimeDeadlineDriver } from '../runtime-deadline.js';
import type { RuntimeDeadlineDriver } from '../runtime-deadline.js';
import type { RuntimeUnitInstance } from '../composition/runtime-unit.js';
import { ModelTestRunner } from './model-test.js';

const settings = {
  baseURL: 'https://test.example/v1',
  models: [{ modelId: 'one', protocol: 'openai-responses' }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
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
    id: 'relay', protocol: 'test', getModelCatalog: async () => ({ models: [{ modelId: 'one' }], resolveModel: (modelId, connection) => ({
      ok: true, descriptor: { invocationPort: { chat, chatStream: () => { throw new Error('Unexpected stream.'); } },
        identity: { providerId: 'relay', modelId }, protocol: 'test', connection,
        facts: { effectiveContextLimit: 4096 },
      },
    }),  }),

    resolveConnection: () => ({ ok: true, connection: { endpointId: 'loaded-connection' } }),

  };
  coordinator.commitPublish(finalizeRegistrySnapshot({
    candidate: { providers: [provider], units: [], diagnostics: [] },
    acceptedUnits: [], channelBindings: [], generation,
  }));
}

function fakeClockDriver(): RuntimeDeadlineDriver {
  const system = createSystemRuntimeDeadlineDriver();
  return {
    now: () => Date.now(),
    race: (operation, deadline) => system.race(operation, system.now() + Math.max(0, deadline - Date.now())),
  };
}

function candidate(expectedRevision = 'saved', credentials?: unknown): SettingsActionRequest {
  return {
    requestId: 'candidate-test', action: 'test_llm_model',
    input: {
      reference: { providerId: 'builtin', modelId: 'one' },
      builtin: { settings, expectedRevision, credentials },
    },
  };
}

const loaded: SettingsActionRequest = {
  requestId: 'loaded-test', action: 'test_llm_model',
  input: { reference: { providerId: 'relay', modelId: 'one' } },
};

function fixture(overrides: Partial<ConstructorParameters<typeof ModelTestRunner>[0]> = {}) {
  const state: {
    document: AgentConfigDocument;
    revision: string | undefined;
    fileStateUnknown: boolean;
  } = {
    document: { llm: { builtin: { ...settings, apiKey: '${SAVED_KEY}' } } },
    revision: 'saved', fileStateUnknown: false,
  };
  const getSavedState = vi.fn(() => state);
  const runner = new ModelTestRunner({
    getSavedState, environment: { SAVED_KEY: 'runtime-secret' }, ...overrides,
  });
  return { runner, state, getSavedState };
}

describe('ModelTestRunner', () => {
  afterEach(() => vi.useRealTimers());

  it('reads current credential facts without caching or mutating saved state', async () => {
    const chat = vi.fn<ModelInvocationPort['chat']>(async () => modelResponse());
    const unit = testUnit(chat);
    const { runner, state } = fixture({ createBuiltinProviderUnit: unit.factory });
    const original = structuredClone(state.document);
    expect(await runner.execute(candidate('stale'))).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(unit.factory).not.toHaveBeenCalled();
    expect(await runner.execute(candidate())).toMatchObject({ ok: true });
    expect(unit.factory.mock.calls[0]?.[0].apiKey).toBe('runtime-secret');
    expect(state.document).toEqual(original);
    state.revision = 'new-revision';
    expect(await runner.execute(candidate())).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    state.fileStateUnknown = true;
    expect(await runner.execute(candidate('new-revision'))).toMatchObject({ ok: false, error: { code: 'file_state_unknown' } });
    expect(await runner.execute(candidate('stale', { '/builtin/apiKey': { operation: 'clear' } }))).toMatchObject({ ok: true });
    expect(unit.factory.mock.calls[1]?.[0]).not.toHaveProperty('apiKey');
    expect(unit.stop).toHaveBeenCalledTimes(2);
  });

  it('pins the selected loaded generation across publication without reading saved state', async () => {
    const call = deferred<ModelInvocationResponse>();
    const entered = deferred<void>();
    const oldChat = vi.fn(async () => { entered.resolve(); return call.promise; });
    const currentChat = vi.fn(async () => modelResponse());
    const coordinator = new CompositionCoordinator();
    publishProvider(coordinator, oldChat);
    const { runner, getSavedState } = fixture({ snapshotAccess: coordinator.createSnapshotAccess() });
    const running = runner.execute(loaded);
    await entered.promise;
    publishProvider(coordinator, currentChat, 2);
    expect(coordinator.pinCount(1)).toBe(1);
    expect(currentChat).not.toHaveBeenCalled();
    call.resolve(modelResponse());
    expect(await running).toMatchObject({ ok: true });
    expect(coordinator.pinCount(1)).toBe(0);
    expect(await runner.execute(loaded)).toMatchObject({ ok: true });
    expect(coordinator.pinCount(2)).toBe(0);
    expect(getSavedState).not.toHaveBeenCalled();
  });

  it('returns safe invocation and incomplete-call failures and cleans up after resolution errors', async () => {
    const chat = vi.fn<ModelInvocationPort['chat']>();
    chat.mockRejectedValueOnce(new ModelInvocationError('authentication'));
    chat.mockResolvedValueOnce({ ...modelResponse(), stopReason: 'aborted' });
    const unit = testUnit(chat);
    const { runner } = fixture({ createBuiltinProviderUnit: unit.factory });
    expect(await runner.execute(candidate())).toMatchObject({
      ok: false, error: { code: 'test_invocation_failed', message: 'Model Test invocation failed: authentication.' },
      output: { reference: { providerId: 'builtin', modelId: 'one' } },
    });
    expect(await runner.execute(candidate())).toMatchObject({ ok: false, error: { code: 'test_incomplete' } });
    expect(await runner.execute({
      ...candidate(), input: {
        reference: { providerId: 'builtin', modelId: 'not-registered' },
        builtin: { settings, expectedRevision: 'saved' },
      },
    })).toMatchObject({ ok: false, error: { code: 'model_resolution_failed' } });
    expect(unit.stop).toHaveBeenCalledTimes(3);
    expect(chat).toHaveBeenCalledTimes(2);
    chat.mockRejectedValueOnce(new Error('private-upstream-error'));
    const unknown = await runner.execute(candidate());
    expect(unknown).toMatchObject({ ok: false, error: { code: 'settings_failed' } });
    expect(JSON.stringify(unknown)).not.toContain('private-upstream-error');
    expect(unit.stop).toHaveBeenCalledTimes(4);
  });

  it('reports safe creation failures and missing loaded access without invoking a Provider', async () => {
    const unit = testUnit(vi.fn());
    const create = vi.fn(async () => { throw new Error('private-create-error'); });
    const { runner } = fixture({
      createBuiltinProviderUnit: config => ({ ...unit.factory(config), create }),
    });
    expect(await runner.execute(loaded)).toMatchObject({ ok: false, error: { code: 'settings_unavailable' } });
    const result = await runner.execute(candidate());
    expect(result).toMatchObject({ ok: false, error: { code: 'settings_failed' } });
    expect(JSON.stringify(result)).not.toContain('private-create-error');
    expect(unit.stop).not.toHaveBeenCalled();
    expect(await runner.shutdown(new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY)))
      .toEqual({ failed: [], residuals: [] });
  });

  it('times out at exactly 30000 ms and keeps a noncooperative invocation pinned until settlement', async () => {
    vi.useFakeTimers();
    const call = deferred<ModelInvocationResponse>();
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    const chat = vi.fn<ModelInvocationPort['chat']>(async request => {
      signal = request.signal; entered.resolve(); return call.promise;
    });
    const coordinator = new CompositionCoordinator();
    publishProvider(coordinator, chat);
    const driver = fakeClockDriver();
    const { runner } = fixture({ snapshotAccess: coordinator.createSnapshotAccess(), deadlineDriver: driver });
    let settled = false;
    const running = runner.execute(loaded).then(result => { settled = true; return result; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ ok: false, error: { code: 'test_timeout' } });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const expired = new RuntimeDeadlineBudget(driver, DEFAULT_RUNTIME_DEADLINE_POLICY, driver.now());
    expect(await runner.shutdown(expired)).toMatchObject({
      failed: [], residuals: [{ requestId: loaded.requestId, phase: 'settings-test-invoking' }],
    });
    expect(coordinator.pinCount(1)).toBe(1);
    call.resolve(modelResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.pinCount(1)).toBe(0);
    expect(chat).toHaveBeenCalledOnce();
    expect(await runner.shutdown(expired)).toEqual({ failed: [], residuals: [] });
  });

  it.each(['timeout', 'shutdown'] as const)('does not invoke after preparation outlives %s cancellation', async cancellation => {
    vi.useFakeTimers();
    const created = deferred<RuntimeUnitInstance>();
    const chat = vi.fn(async () => modelResponse());
    const unit = testUnit(chat);
    const start = vi.fn();
    const stop = vi.fn();
    const driver = fakeClockDriver();
    const { runner } = fixture({
      deadlineDriver: driver,
      createBuiltinProviderUnit: config => ({ ...unit.factory(config), create: () => created.promise }),
    });
    const running = runner.execute(candidate());
    if (cancellation === 'timeout') await vi.advanceTimersByTimeAsync(30_000);
    else runner.beginShutdown();
    expect(await running).toMatchObject({
      ok: false, error: { code: cancellation === 'timeout' ? 'test_timeout' : 'runtime_closing' },
    });
    const expired = new RuntimeDeadlineBudget(driver, DEFAULT_RUNTIME_DEADLINE_POLICY, driver.now());
    expect(await runner.shutdown(expired)).toMatchObject({
      failed: [], residuals: [{ phase: 'settings-test-preparing' }],
    });
    const instance = await unit.factory.mock.results[0]!.value.create(new AbortController().signal);
    created.resolve({ ...instance, start, stop });
    await vi.advanceTimersByTimeAsync(0);
    expect(start).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(await runner.shutdown(expired)).toEqual({ failed: [], residuals: [] });
  });

  it('charges temporary preparation to the same deadline and retains cleanup ownership after timeout', async () => {
    vi.useFakeTimers();
    const created = deferred<RuntimeUnitInstance>();
    const call = deferred<ModelInvocationResponse>();
    const entered = deferred<void>();
    const chat = vi.fn<ModelInvocationPort['chat']>(async () => { entered.resolve(); return call.promise; });
    const unit = testUnit(chat);
    const driver = fakeClockDriver();
    const { runner } = fixture({
      deadlineDriver: driver,
      createBuiltinProviderUnit: config => ({ ...unit.factory(config), create: () => created.promise }),
    });
    const running = runner.execute(candidate());
    await vi.advanceTimersByTimeAsync(29_999);
    created.resolve(await unit.factory.mock.results[0]!.value.create(new AbortController().signal));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ ok: false, error: { code: 'test_timeout' } });
    expect(chat.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(unit.stop).not.toHaveBeenCalled();
    call.resolve(modelResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(unit.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a pending stop after timeout and never stops the temporary Unit twice', async () => {
    vi.useFakeTimers();
    const stopped = deferred<void>();
    const entered = deferred<void>();
    const stop = vi.fn(() => { entered.resolve(); return stopped.promise; });
    const unit = testUnit(async () => modelResponse(), stop);
    const driver = fakeClockDriver();
    const { runner } = fixture({ createBuiltinProviderUnit: unit.factory, deadlineDriver: driver });
    const running = runner.execute(candidate());
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await running).toMatchObject({ ok: false, error: { code: 'test_timeout' } });
    const expired = new RuntimeDeadlineBudget(driver, DEFAULT_RUNTIME_DEADLINE_POLICY, driver.now());
    expect(await runner.shutdown(expired)).toMatchObject({
      failed: [], residuals: [{ phase: 'settings-test-cleanup' }],
    });
    stopped.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runner.shutdown(expired)).toEqual({ failed: [], residuals: [] });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('starts independent Tests concurrently and converges cooperative aborts before shutdown returns', async () => {
    const signals: AbortSignal[] = [];
    const chat = vi.fn<ModelInvocationPort['chat']>(request => new Promise((_resolve, reject) => {
      if (!request.signal) throw new Error('Expected Test signal.');
      signals.push(request.signal);
      request.signal.addEventListener('abort', () => reject(new Error('private-abort-error')), { once: true });
    }));
    const coordinator = new CompositionCoordinator();
    publishProvider(coordinator, chat);
    const { runner } = fixture({ snapshotAccess: coordinator.createSnapshotAccess() });
    const first = runner.execute(loaded);
    const second = runner.execute({ ...loaded, requestId: 'second-test' });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(coordinator.pinCount(1)).toBe(2);
    const closing = runner.shutdown(new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY));
    expect(signals.every(signal => signal.aborted)).toBe(true);
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    }
    expect(await closing).toEqual({ failed: [], residuals: [] });
    expect(coordinator.pinCount(1)).toBe(0);
    expect(await runner.execute(loaded)).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('reports failed cleanup safely and retains one failed owner without retrying stop', async () => {
    const stop = vi.fn(async () => { throw new Error('private-stop-error'); });
    const unit = testUnit(async () => modelResponse(), stop);
    const { runner } = fixture({ createBuiltinProviderUnit: unit.factory });
    const result = await runner.execute(candidate());
    expect(result).toMatchObject({ ok: false, error: { code: 'test_cleanup_failed' } });
    expect(JSON.stringify(result)).not.toContain('private-stop-error');
    const budget = new RuntimeDeadlineBudget(createSystemRuntimeDeadlineDriver(), DEFAULT_RUNTIME_DEADLINE_POLICY);
    expect(await runner.shutdown(budget)).toEqual({
      failed: [{
        resource: 'settings-test:candidate-test', message: 'Temporary model Test resource cleanup failed.',
      }],
      residuals: [],
    });
    expect(await runner.shutdown(budget)).toMatchObject({ failed: [{ resource: 'settings-test:candidate-test' }] });
    expect(stop).toHaveBeenCalledOnce();
  });
});
