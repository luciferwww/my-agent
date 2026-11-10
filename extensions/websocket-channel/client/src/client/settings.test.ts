import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsRequests, credentialDraft, SAVED_CREDENTIAL_MASK, modelDraft, modelSettings, parseSection, settingsProviders } from './settings';

afterEach(() => vi.useRealTimers());

describe('Settings client', () => {
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
