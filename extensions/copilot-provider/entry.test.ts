import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ProviderProjectionEntry, RuntimeUnitInstance } from 'my-agent/extension-api';
import { discoverExtensionDescriptors } from '../../src/extension/acquisition/discovery.js';
import { loadExtensionCandidate } from '../../src/extension/acquisition/loader.js';
import { createExtension } from './entry.js';
import { FileCredentials } from './credentials.js';
import { LoginServer } from './login-server.js';
import * as platform from './platform.js';

const httpFetch = globalThis.fetch;
const instances: RuntimeUnitInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function activeFixture(saved?: string, savedStatus?: 401 | 403) {
  let credential = saved;
  const load = vi.spyOn(FileCredentials.prototype, 'load').mockImplementation(async () => credential);
  const save = vi.spyOn(FileCredentials.prototype, 'save').mockImplementation(async (token, signal) => {
    signal.throwIfAborted();
    credential = token;
  });
  const clear = vi.spyOn(FileCredentials.prototype, 'clear').mockImplementation(async () => { credential = undefined; });
  const open = vi.spyOn(platform, 'openLoginPage').mockResolvedValue(undefined);
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      if (savedStatus && new Headers(init?.headers).get('authorization') === `token ${saved}`) {
        return new Response('', { status: savedStatus });
      }
      return json({
        token: 'synthetic-copilot-token', expires_at: Date.now() / 1000 + 300,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      });
    }
    if (url === 'https://api.individual.githubcopilot.com/models') {
      return json({ data: [{
        id: 'model-a', name: 'Model A', supported_endpoints: ['/chat/completions'],
        capabilities: {
          supports: { tool_calls: true, vision: false },
          limits: { max_context_window_tokens: 32_000, max_output_tokens: 4096 },
        },
      }] });
    }
    if (url === 'https://api.individual.githubcopilot.com/chat/completions') {
      return new Response([
        { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]',
      ].map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
    }
    if (url === 'https://api.individual.githubcopilot.com/responses') {
      return new Response([
        { type: 'response.created', response: {} },
        { type: 'response.output_text.delta', delta: 'Responses Hello' },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    }
    if (url === 'https://github.com/login/device/code') {
      return json({
        device_code: 'synthetic-device-token', user_code: 'TEST-1234',
        verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 1,
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return json({ access_token: 'synthetic-new-github-token' });
    }
    throw new Error('Unexpected upstream request in model discovery test.');
  });
  vi.stubGlobal('fetch', upstream);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const unit = createExtension({ config: {}, logger });
  const instance = await unit.create(new AbortController().signal);
  instances.push(instance);
  let provider: ProviderProjectionEntry | undefined;
  instance.registration.register({
    registerProvider: (entry) => { provider = entry; },
    registerChannel: vi.fn(), registerHook: vi.fn(), registerTool: vi.fn(),
  });
  await instance.start(new AbortController().signal);
  if (!provider) throw new Error('Active Copilot provider was not registered.');
  const openPage = async () => {
    await expect.poll(() => open.mock.calls.length).toBeGreaterThan(0);
    const url = new URL(open.mock.calls.at(-1)![0]);
    const headers = { authorization: `Bearer ${url.hash.slice(1)}`, origin: url.origin };
    const response = await httpFetch(`${url.origin}/api/events`, { headers });
    const reader = response.body!.getReader();
    await reader.read();
    return {
      close: () => reader.cancel(),
      call: (action: string) => httpFetch(`${url.origin}/api/${action}`, { headers, method: 'POST' }),
      status: async () => (await httpFetch(`${url.origin}/api/status`, { headers })).json(),
    };
  };
  return { unit, instance, provider, logger, load, save, clear, open, upstream, openPage };
}

describe('Copilot login experiment extension', () => {
  it('loads through the actual descriptor/schema/Jiti boundary and registers without extra configuration', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const discovery = await discoverExtensionDescriptors(root);
    const candidate = discovery.candidates.find((entry) => entry.descriptor.id === 'copilot-provider');
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('The experiment descriptor was not discovered.');
    const loaded = await loadExtensionCandidate(candidate, root, { entries: {} }, {});
    expect(loaded).toHaveProperty('unit');
    if (!('unit' in loaded)) throw new Error(`The experiment did not load: ${loaded.diagnostic.code}`);
    const instance = await loaded.unit.create(new AbortController().signal);
    instances.push(instance);
    const registerProvider = vi.fn();
    instance.registration.register({
      registerProvider, registerChannel: vi.fn(), registerHook: vi.fn(), registerTool: vi.fn(),
    });
    await instance.start(new AbortController().signal);
    await instance.stop();
    expect(registerProvider).toHaveBeenCalledTimes(1);
  });

  it('is skipped when disabled through the host extension configuration', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const discovery = await discoverExtensionDescriptors(root);
    const candidate = discovery.candidates.find((entry) => entry.descriptor.id === 'copilot-provider');
    if (!candidate) throw new Error('The experiment descriptor was not discovered.');
    const loaded = await loadExtensionCandidate(candidate, root, {
      entries: { 'copilot-provider': { enabled: false } },
    }, {});
    expect(loaded).toMatchObject({
      diagnostic: { category: 'disabled', code: 'extension_disabled', extensionId: 'copilot-provider' },
    });
  });

  it('registers without I/O and discovers real upstream models using saved credentials without opening a page', async () => {
    const app = await activeFixture('synthetic-saved-token');
    expect(app.load).not.toHaveBeenCalled();
    expect(app.open).not.toHaveBeenCalled();
    expect(app.upstream).not.toHaveBeenCalled();
    const catalog = await app.provider.getModelCatalog();
    expect(catalog.models).toMatchObject([{ modelId: 'model-a', displayName: 'Model A' }]);
    expect(app.open).not.toHaveBeenCalled();
    expect(app.provider.resolveConnection()).toMatchObject({ ok: true });
    expect(catalog.resolveModel('model-a', { endpointId: 'github-copilot' })).toMatchObject({ ok: true });
    expect(catalog.resolveModel('unknown', { endpointId: 'github-copilot' })).toMatchObject({ ok: false });
    expect(catalog.resolveModel('model-a', { endpointId: 'unused' })).toMatchObject({ ok: false });
  });

  it('coalesces unsigned model queries, keeps another caller alive on cancellation, and resumes after browser sign-in', async () => {
    const app = await activeFixture();
    const caller = new AbortController();
    const first = expect(app.provider.getModelCatalog(caller.signal)).rejects.toThrow('First caller cancelled');
    const second = app.provider.getModelCatalog();
    const page = await app.openPage();
    caller.abort(new Error('First caller cancelled'));
    await first;
    expect(app.open).toHaveBeenCalledTimes(1);
    expect(await page.status()).toMatchObject({ state: 'signed-out', needsLogin: true });
    expect(app.upstream).not.toHaveBeenCalled();
    expect((await page.call('login')).status).toBe(202);
    expect((await second).models).toMatchObject([{ modelId: 'model-a', displayName: 'Model A' }]);
    expect(app.save).toHaveBeenCalledTimes(1);
    expect(app.clear).not.toHaveBeenCalled();
    await page.close();
  });

  it('requests fresh sign-in on HTTP 401 without deleting the old credential or rechecking it in the page', async () => {
    const app = await activeFixture('synthetic-expired-token', 401);
    const pending = app.provider.getModelCatalog();
    const page = await app.openPage();
    expect(await page.status()).toMatchObject({ state: 'signed-out', saved: true, needsLogin: true });
    expect(app.upstream).toHaveBeenCalledTimes(1);
    expect(app.save).not.toHaveBeenCalled();
    await page.call('login');
    expect((await pending).models).toHaveLength(1);
    expect(app.clear).not.toHaveBeenCalled();
    expect(app.save).toHaveBeenCalledWith('synthetic-new-github-token', expect.any(AbortSignal));
    await page.close();
  });

  it.each([undefined, 'synthetic-expired-token'])('returns an empty catalog on page closure and does not prompt again (saved: %s)', async (saved) => {
    const app = await activeFixture(saved, 401);
    const pending = app.provider.getModelCatalog();
    const page = await app.openPage();
    await page.close();
    const catalog = await pending;
    expect(catalog.models).toEqual([]);
    expect(catalog.resolveModel('model-a', { endpointId: 'github-copilot' })).toMatchObject({ ok: false, category: 'model_rejected' });
    expect(app.save).not.toHaveBeenCalled();
    expect(app.logger.error).not.toHaveBeenCalled();
    expect(app.logger.info).toHaveBeenCalledWith(expect.stringContaining('paused'));
    expect((await app.provider.getModelCatalog()).models).toEqual([]);
    expect((await app.provider.getModelCatalog()).models).toEqual([]);
    expect(app.open).toHaveBeenCalledTimes(1);
    expect(app.upstream).toHaveBeenCalledTimes(saved ? 1 : 0);
  });

  it('allows sign-in again when the provider instance is recreated', async () => {
    const app = await activeFixture();
    const pending = app.provider.getModelCatalog();
    const page = await app.openPage();
    await page.close();
    expect((await pending).models).toEqual([]);
    await app.instance.stop();

    const next = await app.unit.create(new AbortController().signal);
    instances.push(next);
    let provider: ProviderProjectionEntry | undefined;
    next.registration.register({
      registerProvider: (entry) => { provider = entry; },
      registerChannel: vi.fn(), registerHook: vi.fn(), registerTool: vi.fn(),
    });
    await next.start(new AbortController().signal);
    if (!provider) throw new Error('Re-enabled Copilot provider was not registered.');
    const retry = provider.getModelCatalog();
    await expect.poll(() => app.open.mock.calls.length).toBe(2);
    const reopened = await app.openPage();
    await reopened.close();
    expect((await retry).models).toEqual([]);
  });

  it('does not treat caller cancellation as dismissal of sign-in', async () => {
    const app = await activeFixture();
    const controller = new AbortController();
    const cancelled = expect(app.provider.getModelCatalog(controller.signal)).rejects.toThrow('Caller cancelled');
    const page = await app.openPage();
    controller.abort(new Error('Caller cancelled'));
    await cancelled;
    await page.close();
    const retry = app.provider.getModelCatalog();
    await expect.poll(() => app.open.mock.calls.length).toBe(2);
    const reopened = await app.openPage();
    await reopened.close();
    expect((await retry).models).toEqual([]);
  });

  it('does not open a sign-in loop or return empty success for policy/subscription rejection', async () => {
    const app = await activeFixture('synthetic-saved-token', 403);
    await expect(app.provider.getModelCatalog()).rejects.toThrow('HTTP 403');
    expect(app.open).not.toHaveBeenCalled();
    expect(app.logger.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'));
  });

  it('cancels the device flow and returns an empty catalog when the last page closes during authorization', async () => {
    const app = await activeFixture();
    const pending = app.provider.getModelCatalog();
    const page = await app.openPage();
    await page.call('login');
    expect(await page.status()).toHaveProperty('state', 'waiting-authorization');
    await page.close();
    expect((await pending).models).toEqual([]);
    expect(app.save).not.toHaveBeenCalled();
    expect(app.upstream.mock.calls.some(([url]) => String(url).includes('/oauth/access_token'))).toBe(false);
  });

  it('returns an empty catalog when Sign in is cancelled from its page', async () => {
    const app = await activeFixture();
    const pending = app.provider.getModelCatalog();
    const page = await app.openPage();
    await page.call('login');
    await page.call('cancel');
    expect((await pending).models).toEqual([]);
    expect((await app.provider.getModelCatalog()).models).toEqual([]);
    expect(app.open).toHaveBeenCalledTimes(1);
    expect(app.save).not.toHaveBeenCalled();
    await page.close();
  });

  it('does not leak a late-starting listener when the host stops during credential loading', async () => {
    const app = await activeFixture();
    let finishLoad!: () => void;
    const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
    app.load.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      await loading;
      return undefined;
    });
    const start = vi.spyOn(LoginServer.prototype, 'start');
    const failed = expect(app.provider.getModelCatalog()).rejects.toThrow('stopping');
    await expect.poll(() => app.load.mock.calls.length).toBe(2);
    const stopped = app.instance.stop();
    finishLoad();
    await stopped;
    await failed;
    const url = new URL(await start.mock.results[0]!.value);
    await expect(httpFetch(url.origin)).rejects.toThrow();
    expect(app.open).not.toHaveBeenCalled();
  });

  it('resolves a model-bound invocation port that sends authenticated native requests, not Relay requests', async () => {
    const app = await activeFixture('synthetic-saved-token');
    const catalog = await app.provider.getModelCatalog();
    const result = catalog.resolveModel('model-a', { endpointId: 'github-copilot' });
    if (!result.ok) throw new Error('Expected callable Copilot model.');
    expect(result.descriptor.facts).toMatchObject({ effectiveContextLimit: 32_000, maximumOutputTokens: 4096, toolUse: true });
    const answer = await result.descriptor.invocationPort.chat({
      model: 'model-a', outputTokenLimit: 16, messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(answer.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(answer.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    const call = app.upstream.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
    expect(new Headers(call?.[1]?.headers).get('authorization')).toBe('Bearer synthetic-copilot-token');
    expect(app.open).not.toHaveBeenCalled();
  });

  it('reports an authentication error for bound inference after dismissal instead of returning empty success or prompting again', async () => {
    const app = await activeFixture('synthetic-saved-token');
    const catalog = await app.provider.getModelCatalog();
    const bound = catalog.resolveModel('model-a', { endpointId: 'github-copilot' });
    if (!bound.ok) throw new Error('Expected callable Copilot model.');
    await new FileCredentials().clear();
    const pending = app.provider.getModelCatalog();
    const page = await app.openPage();
    await page.close();
    expect((await pending).models).toEqual([]);
    await expect(bound.descriptor.invocationPort.chat({
      model: 'model-a', messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({ diagnostics: { providerMessage: expect.stringContaining('sign-in was dismissed') } });
    expect(app.open).toHaveBeenCalledTimes(1);
    expect(app.upstream.mock.calls.some(([url]) => String(url).endsWith('/chat/completions'))).toBe(false);
  });

  it('reauthorizes once before retrying an inference rejected with HTTP 401', async () => {
    const app = await activeFixture('synthetic-saved-token');
    const catalog = await app.provider.getModelCatalog();
    const bound = catalog.resolveModel('model-a', { endpointId: 'github-copilot' });
    if (!bound.ok) throw new Error('Expected callable Copilot model.');
    const original = app.upstream.getMockImplementation();
    if (!original) throw new Error('Missing test upstream.');
    let attempts = 0;
    app.upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/chat/completions') && ++attempts === 1) return new Response('', { status: 401 });
      return original(...args);
    });
    const pending = bound.descriptor.invocationPort.chat({ model: 'model-a', messages: [{ role: 'user', content: 'Hello' }] });
    const page = await app.openPage();
    await page.call('login');
    expect((await pending).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(attempts).toBe(2);
    expect(app.open).toHaveBeenCalledTimes(1);
    await page.close();
  });

  it('keeps old model bindings on their original protocol and facts after a newer catalog arrives', async () => {
    const app = await activeFixture('synthetic-saved-token');
    const old = await app.provider.getModelCatalog();
    const original = app.upstream.getMockImplementation();
    if (!original) throw new Error('Missing test upstream.');
    app.upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/models')) return new Response(JSON.stringify({ data: [{
        id: 'model-a', supported_endpoints: ['/responses'],
        capabilities: { supports: { tool_calls: true }, limits: { max_context_window_tokens: 64_000, max_output_tokens: 2048 } },
      }] }));
      return original(...args);
    });
    const fresh = await app.provider.getModelCatalog();
    const before = old.resolveModel('model-a', { endpointId: 'github-copilot' });
    const after = fresh.resolveModel('model-a', { endpointId: 'github-copilot' });
    if (!before.ok || !after.ok) throw new Error('Expected two captured model bindings.');
    expect(before.descriptor.facts.effectiveContextLimit).toBe(32_000);
    expect(after.descriptor.facts.effectiveContextLimit).toBe(64_000);
    const request = { model: 'model-a', messages: [{ role: 'user' as const, content: 'Hello' }] };
    expect((await before.descriptor.invocationPort.chat(request)).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect((await after.descriptor.invocationPort.chat(request)).content).toEqual([{ type: 'text', text: 'Responses Hello' }]);
  });

  it('does not silently reroute a captured model to a changed account endpoint', async () => {
    const app = await activeFixture('synthetic-saved-token');
    const catalog = await app.provider.getModelCatalog();
    const bound = catalog.resolveModel('model-a', { endpointId: 'github-copilot' });
    if (!bound.ok) throw new Error('Expected callable Copilot model.');
    app.upstream.mockResolvedValue(new Response(JSON.stringify({
      token: 'synthetic-new-token', expires_at: Date.now() / 1000 + 300,
      endpoints: { api: 'https://changed-account.invalid' },
    })));
    await expect(bound.descriptor.invocationPort.chat({
      model: 'model-a', messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({ diagnostics: { providerMessage: expect.stringContaining('endpoint changed') } });
    expect(app.open).not.toHaveBeenCalled();
  });
});
