import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPolicyState, SHARED_AGENT_TOOLS_SECTION } from './agent-policy-state.js';
import { SettingsManager } from '../settings/index.js';
import { createDefaultAgentConfig, loadAgentConfig, saveAgentConfigSection } from '../../platform/config/index.js';
import type { AgentConfigDocument, AppConfig } from '../../platform/config/types.js';
import type { SettingsActionResult } from '../../core/settings/index.js';
import type { AgentDefinitionSnapshot } from '../../core/agent-context/index.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object.');
  return value as Record<string, unknown>;
}

function section(result: SettingsActionResult, id: string): Record<string, unknown> {
  const output = record(result.output);
  if (output['section']) return record(output['section']);
  const sections = output['sections'];
  if (!Array.isArray(sections)) throw new Error('Expected Settings sections.');
  return record(sections.find(value => record(value)['id'] === id));
}

describe('applied Agent policies', () => {
  let home: string;
  const names = new Set(['read_file', 'write_file', 'exec', 'task']);
  let definitions: AgentDefinitionSnapshot;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-policy-state-'));
    definitions = {
      definitions: ['reviewer', 'researcher'].map(id => ({
        id, agentDir: join(home, 'agents', id), description: `MD ${id}`,
        contextFiles: [{ path: 'IDENTITY.md', content: `${id} body` }],
        sourceFiles: [{ path: 'IDENTITY.md', content: `---\ndescription: MD ${id}\n---\n${id} body` }],
        missingFiles: ['SOUL.md', 'AGENTS.md', 'TOOLS.md'],
      })),
      diagnostics: [{ agentId: 'broken', path: 'IDENTITY.md', code: 'invalid_definition', message: 'Invalid metadata.' }],
    };
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  function config(): AppConfig {
    return {
      agentHome: home, llm: {}, logger: {},
      agents: {
        steeringEnabled: false, maxSubagentDepth: 3,
        defaults: { ...createDefaultAgentConfig(), tools: { allow: ['read_file'], deny: ['write_file'] } },
        list: [
          { id: 'reviewer', tools: { deny: ['exec'] } },
          { id: 'missing', enabled: false },
        ],
      },
    };
  }
  async function fixture(document: AgentConfigDocument, saveSection = saveAgentConfigSection) {
    await writeFile(join(home, 'config.json'), JSON.stringify(document));
    const snapshot = await loadAgentConfig({ agentHome: home });
    const policies = new AgentPolicyState({ ...snapshot.application, agentHome: home }, definitions, () => names);
    const manager = new SettingsManager({
      agentHome: home, document, agentPolicies: policies, environment: {},
      getModelCatalog: () => ({ generation: 1, defaultSelection: { state: 'unset' }, providers: [] }),
      applyLlmConfiguration: async () => { throw new Error('Agent saves must not reload Providers.'); },
      saveSection,
    });
    const load = () => manager.execute({ requestId: 'load', action: 'load', input: {} });
    const update = async (id: string, settings: unknown, revision?: unknown) => manager.execute({
      requestId: `save-${id}`, action: 'update',
      input: { sectionId: id, settings, expectedRevision: revision ?? section(await load(), id)['revision'] },
    });
    return { manager, policies, load, update };
  }
  const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

  it('publishes execution and Tool settings independently while preserving previously captured state', async () => {
    const f = await fixture({});
    const original = f.policies.capture();
    const execution = await f.update('agents:execution', {
      steeringEnabled: false, maxSubagentDepth: 0, maxLlmCallsPerTurn: 2,
    });
    expect(execution.ok).toBe(true);
    expect(f.policies.capture()).not.toBe(original);
    expect(original.agents).toMatchObject({ steeringEnabled: true, maxSubagentDepth: 1 });
    expect(original.rootToolPolicy.isDenied('task')).toBe(false);
    await f.update('agents:defaults', { tools: { allow: ['read_file'], deny: ['exec'] } });
    const applied = f.policies.capture();
    expect(applied.agents).toMatchObject({ steeringEnabled: false, maxSubagentDepth: 0, maxLlmCallsPerTurn: 2 });
    expect(applied.rootToolPolicy.isDenied('task')).toBe(true);
    expect(applied.profiles.get('general-purpose')?.tools).toEqual({ allow: ['read_file'], deny: ['exec'] });
    await f.update('agents:execution', {});
    expect(f.policies.capture()).not.toBe(applied);
    expect(f.policies.capture().agents).toMatchObject({ steeringEnabled: true, maxSubagentDepth: 1 });
    expect(f.policies.capture().agents).not.toHaveProperty('maxLlmCallsPerTurn');
    expect(applied.agents).toMatchObject({ steeringEnabled: false, maxSubagentDepth: 0, maxLlmCallsPerTurn: 2 });
    expect(section(await f.load(), 'agents:execution')['restartRequired']).toBe(false);
    const restarted = await loadAgentConfig({ agentHome: home });
    expect(restarted.application.agents.defaults.tools).toEqual({ allow: ['read_file'], deny: ['exec'] });
  });

  it('uses shared defaults plus only the selected Agent override, including the permanent fallback', () => {
    const policies = new AgentPolicyState(config(), definitions, () => names);
    const snapshot = policies.capture();
    expect([...snapshot.profiles.keys()]).toEqual(['general-purpose', 'reviewer', 'researcher']);
    expect(snapshot.disabledIds.has('missing')).toBe(true);
    expect(snapshot.profiles.get('reviewer')?.tools).toEqual({ allow: ['read_file'], deny: ['write_file', 'exec'] });
    expect(snapshot.profiles.get('researcher')?.tools).toEqual({ allow: ['read_file'], deny: ['write_file'] });
    expect(snapshot.profiles.get('general-purpose')?.tools).toEqual({ allow: ['read_file'], deny: ['write_file'] });
    expect(policies.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'missing', code: 'definition_unavailable' }),
      expect.objectContaining({ agentId: 'broken', code: 'invalid_definition' }),
    ]));
  });

  it('prepares before publication and preserves already selected policies after shared and local updates', () => {
    const policies = new AgentPolicyState(config(), definitions, () => names);
    const before = policies.capture();
    const publish = policies.prepare({ kind: 'agent-defaults', settings: { tools: { deny: ['read_file'] } } });
    expect(policies.capture()).toBe(before);
    publish();
    const after = policies.capture();
    expect(after).not.toBe(before);
    expect(before.rootToolPolicy.isDenied('write_file')).toBe(true);
    expect(after.rootToolPolicy.isDenied('write_file')).toBe(false);
    expect(after.profiles.get('reviewer')?.tools).toEqual({ allow: [], deny: ['read_file', 'exec'] });
    policies.prepare({ kind: 'agent', agentId: 'reviewer', settings: { tools: { allow: [], deny: [] } } })();
    expect(policies.capture().profiles.get('reviewer')?.tools).toEqual({ allow: [], deny: ['read_file'] });
    expect(after.profiles.get('reviewer')?.tools?.deny).toEqual(['read_file', 'exec']);
    expect(Object.isFrozen(after.profiles.get('reviewer')?.tools?.deny)).toBe(true);
    expect(Object.isFrozen(after.agents)).toBe(true);
  });

  it('recomputes Root tools with startup caller overrides without mixing them into Child tools', () => {
    const policies = new AgentPolicyState(config(), definitions, () => names, {
      cliOverrides: { tools: { deny: ['task'] } },
    });
    policies.prepare({ kind: 'agent-defaults', settings: { tools: { deny: ['write_file'] } } })();
    expect(policies.capture().rootToolPolicy.isDenied('task')).toBe(true);
    expect(policies.capture().profiles.get('general-purpose')?.tools?.deny).toEqual(['write_file']);
  });

  it('publishes disablement without destroying definitions, and rejects reserved or invalid edits', () => {
    const policies = new AgentPolicyState(config(), definitions, () => names);
    policies.prepare({ kind: 'agent', agentId: 'reviewer', settings: { enabled: false } })();
    expect(policies.capture().disabledIds.has('reviewer')).toBe(true);
    expect(policies.capture().profiles.has('reviewer')).toBe(false);
    policies.prepare({ kind: 'agent', agentId: 'reviewer', settings: {} })();
    expect(policies.capture().profiles.has('reviewer')).toBe(true);
    expect(() => policies.prepare({ kind: 'agent', agentId: 'general-purpose', settings: {} })).toThrow();
    expect(() => policies.prepare({ kind: 'agent', agentId: 'reviewer', settings: { tools: { allow: ['unknown'] } } })).toThrow(/Unknown Tool/);
    expect(() => policies.prepare({ kind: 'agent', agentId: 'reviewer', settings: { description: 'UI cannot edit this' } })).toThrow();
  });

  it('loads revisioned backend sections from the same startup Context without materializing defaults', async () => {
    const f = await fixture({});
    const loaded = await f.load();
    expect(section(loaded, 'agent:reviewer')).toMatchObject({
      enabled: true, settings: {}, contextFiles: definitions.definitions[0].sourceFiles,
      instructionFiles: definitions.definitions[0].contextFiles,
      metadata: { description: 'MD reviewer' }, form: { credentials: {} },
      missingFiles: ['SOUL.md', 'AGENTS.md', 'TOOLS.md'], contextRestartRequired: true,
    });

    expect(section(loaded, SHARED_AGENT_TOOLS_SECTION)).toMatchObject({
      agentId: 'general-purpose', builtIn: true, settings: {}, applicationStatus: 'current', form: { credentials: {} },
    });
    const before = await readFile(join(home, 'config.json'), 'utf8');
    expect(await f.update('agent:reviewer', {})).toMatchObject({ ok: true });
    expect(await f.update(SHARED_AGENT_TOOLS_SECTION, {})).toMatchObject({ ok: true });
    expect(await readFile(join(home, 'config.json'), 'utf8')).toBe(before);
    const reviewerRevision = section(await f.load(), 'agent:reviewer')['revision'];
    const updated = await f.update(SHARED_AGENT_TOOLS_SECTION, { tools: { deny: ['exec'] } });
    expect(updated).toMatchObject({
      ok: true, output: {
        agentSections: expect.arrayContaining([expect.objectContaining({
          id: 'agent:reviewer', sharedDeny: ['exec'],
          revision: reviewerRevision,
          metadata: { description: 'MD reviewer' },
        })]),
      },
    });
  });

  it('projects current shared allow and wildcard deny matches without mixing in local deny', async () => {
    const f = await fixture({
      agents: {
        defaults: { tools: { allow: ['read_*'], deny: ['*_file'] } },
        list: [{ id: 'reviewer', tools: { deny: ['exec'] } }],
      },
    });
    expect(section(await f.load(), 'agent:reviewer')).toMatchObject({
      sharedAllow: ['read_*'], sharedDeny: ['*_file'],
      sharedDeniedTools: ['read_file', 'write_file'],
      settings: { tools: { deny: ['exec'] } },
    });
    const saved = await f.update(SHARED_AGENT_TOOLS_SECTION, {
      tools: { allow: ['task'], deny: ['exec'] },
    });
    expect(saved).toMatchObject({
      ok: true, output: {
        agentSections: expect.arrayContaining([expect.objectContaining({
          id: 'agent:reviewer', sharedAllow: ['task'],
          sharedDeny: ['exec'], sharedDeniedTools: ['exec'],
          settings: { tools: { deny: ['exec'] } },
        })]),
      },
    });
  });

  it('persists only the target fields and does not apply unrelated pending-restart changes', async () => {
    const startup: AgentConfigDocument = {
      agents: {
        steeringEnabled: false, maxLlmCallsPerTurn: 5, maxSubagentDepth: 3,
        defaults: { memory: { enabled: false }, tools: { deny: ['write_file'] } },
        list: [{ id: 'reviewer', description: 'Saved description', model: 'inherit', tools: { deny: ['exec'] } }],
      },
      extensions: { entries: { other: { config: { retain: true } } } },
    };
    const f = await fixture(startup);
    const pending = {
      ...startup,
      agents: {
        ...startup.agents, steeringEnabled: true, maxLlmCallsPerTurn: 99, maxSubagentDepth: 0,
        defaults: { ...startup.agents?.defaults, memory: { enabled: true } },
        list: [
          { ...startup.agents?.list?.[0], id: 'reviewer', description: 'Pending description' },
          { id: 'researcher', tools: { deny: ['task'] } },
        ],
      },
    };
    await writeFile(join(home, 'config.json'), JSON.stringify(pending));
    expect(await f.update(SHARED_AGENT_TOOLS_SECTION, { tools: { allow: ['read_file'], deny: [] } })).toMatchObject({ ok: true });
    expect(await read(join(home, 'config.json'))).toEqual({
      ...pending, agents: { ...pending.agents, defaults: { ...pending.agents.defaults, tools: { allow: ['read_file'], deny: [] } } },
    });
    const applied = f.policies.capture();
    expect(applied.agents).toMatchObject({
      steeringEnabled: false, maxLlmCallsPerTurn: 5, maxSubagentDepth: 3,
      defaults: { memory: { enabled: false } },
    });
    expect(applied.profiles.get('reviewer')?.description).toBe('Saved description');
    expect(applied.profiles.get('reviewer')?.tools?.deny).toEqual(['exec']);
    expect(applied.profiles.get('researcher')?.tools?.deny).toEqual([]);
    expect(await f.update('agent:reviewer', { enabled: false, tools: { allow: [], deny: [] } })).toMatchObject({ ok: true });
    const saved = record(await read(join(home, 'config.json')));
    const agents = record(saved['agents']);
    expect(agents['list']).toEqual([
      { id: 'reviewer', description: 'Pending description', model: 'inherit', enabled: false, tools: { allow: [], deny: [] } },
      pending.agents.list[1],
    ]);
    expect(f.policies.capture().profiles.has('reviewer')).toBe(false);
    expect(f.policies.capture().agents.maxSubagentDepth).toBe(3);
  });

  it('keeps state and revision unchanged on validation, revision conflict or persistence failure', async () => {
    const failure = new Error('Write failed.');
    const save = vi.fn(saveAgentConfigSection);
    const f = await fixture({}, save);
    const before = f.policies.capture();
    const revision = section(await f.load(), 'agent:reviewer')['revision'];
    expect(await f.update('agent:reviewer', { enabled: false }, 'stale')).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(await f.update('agent:reviewer', { tools: { allow: ['unknown'] } })).toMatchObject({ ok: false });
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(failure);
    expect(await f.update('agent:reviewer', { enabled: false })).toMatchObject({ ok: false });
    expect(f.policies.capture()).toBe(before);
    expect(section(await f.load(), 'agent:reviewer')['revision']).toBe(revision);
    expect(await read(join(home, 'config.json'))).toEqual({});
  });

  it('serializes competing section updates and makes save acknowledgement follow atomic publication', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const save = vi.fn(saveAgentConfigSection).mockImplementationOnce(async (...args) => {
      entered();
      await blocked;
      return saveAgentConfigSection(...args);
    });
    const f = await fixture({}, save);
    const loaded = await f.load();
    const before = f.policies.capture();
    const first = f.update('agent:reviewer', { enabled: false }, section(loaded, 'agent:reviewer')['revision']);
    await started;
    const stale = f.update('agent:reviewer', { tools: { deny: ['exec'] } }, section(loaded, 'agent:reviewer')['revision']);
    const shared = f.update(SHARED_AGENT_TOOLS_SECTION, { tools: { deny: ['write_file'] } }, section(loaded, SHARED_AGENT_TOOLS_SECTION)['revision']);
    expect(f.policies.capture()).toBe(before);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(f.policies.capture().disabledIds.has('reviewer')).toBe(true);
    expect(await stale).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    expect(await shared).toMatchObject({ ok: true });
    expect(f.policies.capture().profiles.get('general-purpose')?.tools?.deny).toEqual(['write_file']);
    expect(f.policies.capture().profiles.has('reviewer')).toBe(false);
  });
});
