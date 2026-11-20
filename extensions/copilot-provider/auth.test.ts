import { describe, expect, it, vi } from 'vitest';
import { deviceLogin, discoverCopilotModels, LoginRequiredError, verifyCopilot } from './auth.js';

function response(value: unknown) {
  return new Response(JSON.stringify(value));
}

const device = {
  device_code: 'private-device-code', user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 1,
};

describe('Copilot device authorization', () => {
  it('displays the GitHub code and honors pending and slow-down before returning the token', async () => {
    let clock = 0;
    const waits: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(response({ error: 'slow_down' }))
      .mockResolvedValueOnce(response({ access_token: 'github-test-secret' }));
    const display = vi.fn();
    await expect(deviceLogin({
      signal: new AbortController().signal, fetch: fetchImpl, display, now: () => clock,
      wait: async (ms) => { waits.push(ms); clock += ms; },
    })).resolves.toBe('github-test-secret');
    expect(display).toHaveBeenCalledWith('https://github.com/login/device', 'ABCD-1234');
    expect(waits).toEqual([1000, 1000, 6000]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      device_code: 'private-device-code',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

  });

  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ])('reports %s without exposing tokens', async (error, message) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ error }));
    await expect(deviceLogin({
      signal: new AbortController().signal, fetch: fetchImpl,
      display() {}, wait: async () => {},
    })).rejects.toThrow(message);
  });

  it('cancels polling and rejects untrusted verification URLs', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(device));
    await expect(deviceLogin({
      signal: controller.signal, fetch: fetchImpl, display() {},
      wait: async () => { controller.abort(new Error('Cancelled')); },
    })).rejects.toThrow('Cancelled');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(deviceLogin({
      signal: new AbortController().signal,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({
        ...device, verification_uri: 'https://untrusted.invalid/login',
      })), display() {},
    })).rejects.toThrow('invalid device');
  });

  it('requires usable Copilot access, not just successful GitHub login', async () => {
    const options = { signal: new AbortController().signal };
    await expect(verifyCopilot('synthetic-token', {
      ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(response({})),
    })).rejects.toThrow('usable Copilot');
    await expect(verifyCopilot('synthetic-token', {
      ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(response({
        token: 'copilot-test-secret', expires_at: Date.now() / 1000 + 300,
      })),
    })).resolves.toBeUndefined();
  });
});

describe('Copilot model discovery', () => {
  const access = {
    token: 'synthetic-copilot-token', expires_at: Date.now() / 1000 + 300,
    endpoints: { api: 'https://api.individual.githubcopilot.com' },
  };
  const options = { signal: new AbortController().signal };

  it('uses the exchanged token and account endpoint, retaining metadata for provider binding', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(access))
      .mockResolvedValueOnce(response({ data: [
        { id: 'model-a', name: 'Model A', ignored: 'not catalog metadata' }, { id: 'model-b' },
      ] }));
    await expect(discoverCopilotModels('synthetic-github-token', {
      ...options, fetch: fetchImpl,
    })).resolves.toMatchObject([
      { modelId: 'model-a', displayName: 'Model A', apiBase: 'https://api.individual.githubcopilot.com', metadata: { id: 'model-a' } },
      { modelId: 'model-b' },
    ]);
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty('authorization', 'token synthetic-github-token');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.individual.githubcopilot.com/models');
    expect(fetchImpl.mock.calls[1][1]?.headers).toHaveProperty('authorization', 'Bearer synthetic-copilot-token');
  });

  it('distinguishes invalid credentials from subscription/policy rejection', async () => {
    await expect(discoverCopilotModels('synthetic', {
      ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 })),
    })).rejects.toBeInstanceOf(LoginRequiredError);
    await expect(discoverCopilotModels('synthetic', {
      ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 })),
    })).rejects.toThrow('HTTP 403');
  });

  it.each([
    undefined, 'http://insecure.invalid', 'https://user:password@untrusted.invalid',
    'https://endpoint.invalid/?query=unexpected',
  ])('does not send a Copilot token to an invalid API endpoint (%s)', async (api) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ ...access, endpoints: { api } }));
    await expect(discoverCopilotModels('synthetic', { ...options, fetch: fetchImpl })).rejects.toThrow('endpoint');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { data: [{ id: 'duplicate' }, { id: 'duplicate' }] }, { data: [{ name: 'Missing ID' }] },
  ])('rejects malformed catalog data instead of reporting an empty success', async (payload) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(access)).mockResolvedValueOnce(response(payload));
    await expect(discoverCopilotModels('synthetic', { ...options, fetch: fetchImpl })).rejects.toThrow();
  });

  it('bounds the model response at two MiB', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(access))
      .mockResolvedValueOnce(response({ data: [], padding: 'x'.repeat(2 * 1024 * 1024) }));
    await expect(discoverCopilotModels('synthetic', { ...options, fetch: fetchImpl })).rejects.toThrow('too large');
  });
});
