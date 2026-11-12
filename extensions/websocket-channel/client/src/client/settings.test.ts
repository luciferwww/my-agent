import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsRequests, agentPolicySettings, executionPolicySettings, credentialDraft, SAVED_CREDENTIAL_MASK, modelDraft, modelSettings, parseSection, settingsProviders, settingsTools } from './settings';

afterEach(() => vi.useRealTimers());

describe('Settings client', () => {
  const execution = {
    id: 'agents:execution', kind: 'agent-execution', revision: 'execution-revision',
    restartRequired: false, settings: {}, form: { credentials: {} },
    defaults: { steeringEnabled: false, maxSubagentDepth: 1 },
    resolvedSettings: { steeringEnabled: false, maxSubagentDepth: 1 },
  };

  it('parses execution defaults and sparse saved values without inventing a call limit', () => {
    const section = parseSection(execution);
    expect(section.settings).toEqual({});
    expect(section.execution).toEqual({
      defaults: execution.defaults, resolved: execution.resolvedSettings,
    });
    expect(executionPolicySettings({})).toEqual({});
    expect(executionPolicySettings({ steeringEnabled: false, maxSubagentDepth: '0', maxLlmCallsPerTurn: '3' }))
      .toEqual({ steeringEnabled: false, maxSubagentDepth: 0, maxLlmCallsPerTurn: 3 });
  });

  it.each([
    { resolvedSettings: undefined }, { kind: 'extension' },
    { defaults: { maxSubagentDepth: 1 } },
    { resolvedSettings: { steeringEnabled: false, maxSubagentDepth: -1 } },
    { resolvedSettings: { steeringEnabled: true, maxSubagentDepth: 1, maxLlmCallsPerTurn: 0 } },
    { settings: { steeringEnabled: null } }, { settings: { other: true } },
  ])('rejects malformed execution view %#', patch => {
    expect(() => parseSection({ ...execution, ...patch })).toThrow();
  });

  it.each([
    { maxSubagentDepth: '' }, { maxSubagentDepth: ' ' }, { maxSubagentDepth: '-1' },
    { maxSubagentDepth: '1.5' }, { maxLlmCallsPerTurn: '' }, { maxLlmCallsPerTurn: '0' },
    { maxLlmCallsPerTurn: 'Infinity' }, { maxLlmCallsPerTurn: 'invalid' },
    { maxLlmCallsPerTurn: '9007199254740992' },
  ])('rejects blank or invalid execution draft %# instead of silently coercing it', draft => {
    expect(() => executionPolicySettings(draft)).toThrow();
  });

  it('parses read-only Agent views and preserves explicit empty allow and untouched sparse tools', () => {
    const raw = {
      id: 'agent:reviewer', revision: 'revision', kind: 'agent', restartRequired: false,
      enabled: true, definitionAvailable: true, model: { providerId: 'relay', modelId: 'opaque/model' },
      form: { credentials: {} }, settings: { tools: { allow: [], deny: [] } },
      contextFiles: [], instructionFiles: [], metadata: { description: 'Review code' },
      missingFiles: ['SOUL.md'], sharedAllow: ['read_file'], sharedDeny: ['exec'], sharedDeniedTools: ['exec'],
    };
    const section = parseSection(raw);
    expect(section.agent).toMatchObject({
      builtIn: false, enabled: true, missingFiles: ['SOUL.md'],
      sharedAllow: ['read_file'], sharedDeny: ['exec'], sharedDeniedTools: ['exec'],
      model: { providerId: 'relay', modelId: 'opaque/model' },
    });
    expect(agentPolicySettings(section, { enabled: true, allowMode: 'explicit', allow: '', deny: '' }))
      .toEqual(raw.settings);
    expect(agentPolicySettings(parseSection({ ...raw, settings: {} }), {
      enabled: true, allowMode: 'inherit', allow: '', deny: '',
    })).toEqual({});
    expect(() => parseSection({ ...raw, sharedDeny: [false] })).toThrow();
    expect(() => parseSection({ ...raw, sharedAllow: undefined })).toThrow();
    expect(() => parseSection({ ...raw, sharedAllow: [false] })).toThrow();
    expect(() => parseSection({ ...raw, sharedDeniedTools: [false] })).toThrow();
    expect(() => parseSection({ ...raw, instructionFiles: [{}] })).toThrow();
    expect(() => parseSection({ ...raw, settings: { tools: { allow: 'exec' } } })).toThrow();
    expect(() => parseSection({ ...raw, model: { modelId: 'model' } })).toThrow();
  });

  it('parses only safe Tool catalog fields and rejects malformed entries', () => {
    expect(settingsTools([
      { name: 'exec', description: 'Run commands.', inputSchema: { private: true } },
      { name: 'read_file', description: 'Read a file.' },
    ])).toEqual([
      { name: 'exec', description: 'Run commands.' },
      { name: 'read_file', description: 'Read a file.' },
    ]);
    expect(settingsTools([])).toEqual([]);
    for (const value of [undefined, {}, [null], [{ name: 'exec' }], [{ name: 1, description: '' }]]) {
      expect(() => settingsTools(value)).toThrow();
    }
  });

  it('preserves explicit Provider configuration links without inferring them from IDs', () => {
    expect(settingsProviders({ providers: [
      { providerId: 'provider-one', configurationSectionId: 'extension:relay', models: [{ modelId: 'one' }] },
      { providerId: 'provider-two', displayName: 'Second', configurationSectionId: 'extension:relay', models: [] },
      { providerId: 'relay', models: [] },
    ] })).toEqual([
      { providerId: 'provider-one', name: 'provider-one', configurationSectionId: 'extension:relay', models: [{ modelId: 'one', name: 'one' }] },
      { providerId: 'provider-two', name: 'Second', configurationSectionId: 'extension:relay', models: [] },
      { providerId: 'relay', name: 'relay', configurationSectionId: undefined, models: [] },
    ]);
    expect(() => settingsProviders({ providers: [{ providerId: 'bad', models: [], configurationSectionId: 1 }] })).toThrow();
  });

  it('maps the saved credential mask, replacements and empty input to explicit intents', () => {
    expect(credentialDraft(SAVED_CREDENTIAL_MASK, true)).toEqual({ operation: 'keep', value: '' });
    expect(credentialDraft('literal-key', true)).toEqual({ operation: 'replace', value: 'literal-key' });
    expect(credentialDraft('${API_KEY}', true)).toEqual({ operation: 'replace', value: '${API_KEY}' });
    expect(credentialDraft('', true)).toEqual({ operation: 'clear', value: '' });
    expect(credentialDraft('', false)).toEqual({ operation: 'clear', value: '' });
    expect(credentialDraft(SAVED_CREDENTIAL_MASK, false)).toEqual({ operation: 'replace', value: SAVED_CREDENTIAL_MASK });
  });

  it('correlates actions, preserves explicit failures and never resends interrupted requests', async () => {
    const send = vi.fn();
    const requests = new SettingsRequests(send);
    const loading = requests.execute('load', {});
    expect(requests.receive({ requestId: 'settings-1', action: 'update', ok: true })).toBe(false);
    expect(requests.receive({ requestId: 'settings-1', action: 'load', ok: true, output: { sections: [] } })).toBe(true);
    expect(await loading).toMatchObject({ ok: true, output: { sections: [] } });
    const saving = requests.execute('update', { sectionId: 'llm' });
    const failure = {
      requestId: 'settings-2', action: 'update', ok: false,
      error: { code: 'application_failed_rolled_back', message: 'Restored.' },
      output: { section: { revision: 'fresh' }, rollback: 'completed' },
    };
    expect(requests.receive(failure)).toBe(true);
    expect(await saving).toEqual(failure);
    const interrupted = requests.execute('update', {});
    requests.interrupt();
    expect(await interrupted).toMatchObject({ ok: false, error: { code: 'connection_lost' } });
    expect(requests.receive({ requestId: 'settings-3', action: 'update', ok: true })).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('bounds response waiting, reports malformed results and clears timers on send failures', async () => {
    vi.useFakeTimers();
    const requests = new SettingsRequests(vi.fn());
    const missing = requests.execute('update', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await missing).toMatchObject({ ok: false, error: { code: 'request_timeout' } });
    const malformed = requests.execute('load', {});
    expect(() => requests.receive({ requestId: 'settings-2', action: 'load', ok: false, error: {} })).toThrow();
    requests.interrupt('invalid_response');
    expect(await malformed).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    const unavailable = new SettingsRequests(() => { throw new Error('Socket closed.'); });
    await expect(unavailable.execute('load', {})).rejects.toThrow('Socket closed.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('round-trips model advanced fields and keeps credential metadata separate from settings', () => {
    const model = {
      modelId: 'model', protocol: 'openai-responses', endpoint: '/responses',
      maximumContextTokens: 200_000, maximumPromptTokens: 180_000,
      maximumOutputTokens: 20_000, outputTokenLimit: 1000,
      reasoning: { thinking: ['on'], efforts: ['high'] },
    };
    expect(modelSettings(modelDraft(model))).toEqual(model);
    const section = parseSection({
      id: 'llm', revision: 'revision', restartRequired: false, settings: { builtin: { models: [model] } },
      form: { credentials: { '/builtin/apiKey': { configured: true, source: 'environment' } } },
    });
    expect(section.credentials['/builtin/apiKey']).toEqual({ configured: true, source: 'environment' });
    expect(section.settings).not.toHaveProperty('credentials');
    expect(() => modelSettings({ ...modelDraft(model), advanced: '[]' })).toThrow();
    expect(() => parseSection({})).toThrow();
  });
});
