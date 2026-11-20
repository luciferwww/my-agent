import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { deviceLogin } from './auth.js';
import { LoginError } from './auth.js';
import { LoginServer } from './login-server.js';

const servers: LoginServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });

async function fixture(options: {
  login?: typeof deviceLogin;
  saved?: string;
  verify?: () => Promise<void>;
  clear?: () => Promise<void>;
} = {}) {
  let credential = options.saved;
  const save = vi.fn(async (value: string) => { credential = value; });
  const clear = vi.fn(async () => { await options.clear?.(); credential = undefined; });
  const reportError = vi.fn();
  const server = new LoginServer({
    credentials: { load: async () => credential, save, clear },
    login: options.login ?? (async ({ display }) => {
      display('https://github.com/login/device', 'ABCD-1234');
      return 'synthetic-github-secret';
    }),
    verify: options.verify ?? (async () => {}),
    reportError,
  });
  servers.push(server);
  const url = new URL(await server.start());
  const headers = { authorization: `Bearer ${url.hash.slice(1)}`, origin: url.origin };
  const events = await fetch(`${url.origin}/api/events`, { headers });
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const nextEvent = async () => {
    while (!pending.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('The login status stream ended unexpectedly.');
      pending += decoder.decode(value, { stream: true });
    }
    const end = pending.indexOf('\n\n');
    const event = pending.slice(0, end);
    pending = pending.slice(end + 2);
    expect(event.startsWith('data: ')).toBe(true);
    const value: unknown = JSON.parse(event.slice(6));
    return value;
  };
  const call = (path: string, method = 'GET') => fetch(`${url.origin}/api/${path}`, { method, headers });
  const status = async () => {
    const value: unknown = await (await call('status')).json();
    if (!value || typeof value !== 'object' || !('state' in value) || typeof value.state !== 'string') {
      throw new Error('Invalid experiment status response.');
    }
    return value;
  };
  return {
    server, url, headers, call, status, save, clear, reportError,
    nextEvent, closePage: () => reader.cancel(),
  };
}

describe('isolated extension login page', () => {
  it('publishes the user code and URL only after login, verifies before saving, and never exposes account tokens', async () => {
    let verified = false;
    let authorize!: (token: string) => void;
    const authorized = new Promise<string>((resolve) => { authorize = resolve; });
    const login = vi.fn<typeof deviceLogin>(({ display }) => {
      display('https://github.com/login/device', 'ABCD-1234');
      return authorized;
    });
    const app = await fixture({ login, verify: async () => { verified = true; } });
    expect(await (await fetch(app.url.origin)).text()).toContain('Sign in with GitHub');
    expect(await app.status()).not.toHaveProperty('authorization');
    expect(await app.nextEvent()).toMatchObject({ state: 'signed-out' });
    expect(login).not.toHaveBeenCalled();
    expect((await app.call('login', 'POST')).status).toBe(202);
    expect(await app.nextEvent()).toMatchObject({ state: 'requesting-code' });
    expect(await app.nextEvent()).toMatchObject({
      state: 'waiting-authorization',
      authorization: { url: 'https://github.com/login/device', code: 'ABCD-1234' },
    });
    expect(await app.status()).toMatchObject({
      state: 'waiting-authorization',
      authorization: { url: 'https://github.com/login/device', code: 'ABCD-1234' },
    });
    expect(app.save).not.toHaveBeenCalled();
    authorize('synthetic-github-secret');
    await expect.poll(async () => (await app.status()).state).toBe('verified');
    expect(verified).toBe(true);
    expect(app.save).toHaveBeenCalledWith('synthetic-github-secret', expect.any(AbortSignal));
    const status = JSON.stringify(await app.status());
    expect(status).not.toContain('synthetic-github-secret');
    expect(status).toContain('"saved":true');
    expect(await app.status()).not.toHaveProperty('authorization');
    expect(await app.nextEvent()).toMatchObject({ state: 'verifying' });
    expect(await app.nextEvent()).toMatchObject({ state: 'saving' });
    const completed = await app.nextEvent();
    expect(completed).toMatchObject({ state: 'verified', busy: false });
    expect(JSON.stringify(completed)).not.toContain('synthetic-github-secret');
  });

  it('automatically verifies saved access when the page connects, without a manual check action', async () => {
    const verify = vi.fn(async () => {});
    const app = await fixture({ saved: 'saved-test-secret', verify });
    expect(await app.nextEvent()).toMatchObject({ state: 'verifying', saved: true, busy: true });
    await expect.poll(async () => (await app.status()).state).toBe('verified');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(app.save).not.toHaveBeenCalled();
    expect((await app.call('verify', 'POST')).status).toBe(404);
  });

  it('signs out persistently and does not restore the removed credential when the page reconnects', async () => {
    const app = await fixture({ saved: 'saved-test-secret' });
    await expect.poll(async () => (await app.status()).state).toBe('verified');
    expect((await app.call('logout', 'POST')).status).toBe(202);
    await expect.poll(async () => (await app.status()).state).toBe('signed-out');
    expect(app.clear).toHaveBeenCalledTimes(1);
    expect(await app.status()).toMatchObject({ saved: false, busy: false });
    await app.closePage();
    const reopened = await fetch(`${app.url.origin}/api/events`, { headers: app.headers });
    expect(await app.status()).toMatchObject({ state: 'signed-out', saved: false });
    await reopened.body!.cancel();
  });

  it('surfaces sign-out failure without claiming credentials were removed', async () => {
    const app = await fixture({
      saved: 'saved-test-secret', clear: async () => { throw new Error('simulated file failure'); },
    });
    await expect.poll(async () => (await app.status()).state).toBe('verified');
    await app.call('logout', 'POST');
    await expect.poll(async () => (await app.status()).state).toBe('failed');
    expect(await app.status()).toMatchObject({ saved: true, busy: false });
    expect(app.reportError).toHaveBeenCalledWith(expect.stringContaining('Could not sign out'));
  });

  it('surfaces denied Copilot access without overwriting an existing credential', async () => {
    const app = await fixture({
      saved: 'previous-secret',
      verify: async () => { throw new LoginError('Copilot access denied.'); },
    });
    await app.call('login', 'POST');
    await expect.poll(async () => (await app.status()).state).toBe('failed');
    expect(await app.status()).toMatchObject({ saved: true, message: 'Copilot access denied.' });
    expect(app.save).not.toHaveBeenCalled();
    expect(app.reportError).toHaveBeenCalledWith('Copilot access denied.');
  });

  it('rejects duplicate login, allows cancellation and retries without saving', async () => {
    const login = vi.fn<typeof deviceLogin>(({ signal, display }) => new Promise((_resolve, reject) => {
      display('https://github.com/login/device', 'ABCD-1234');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const app = await fixture({ login });
    await app.call('login', 'POST');
    await expect.poll(() => login.mock.calls.length).toBe(1);
    expect((await app.call('login', 'POST')).status).toBe(409);
    await app.call('cancel', 'POST');
    await expect.poll(async () => (await app.status()).state).toBe('cancelled');
    expect(app.save).not.toHaveBeenCalled();
    expect(await app.status()).not.toHaveProperty('authorization');
    expect((await app.call('login', 'POST')).status).toBe(202);
  });

  it('hides expired codes and requests fresh instructions on retry', async () => {
    let expire!: (error: Error) => void;
    const waiting = new Promise<string>((_resolve, reject) => { expire = reject; });
    const login = vi.fn<typeof deviceLogin>(({ display }) => {
      display('https://github.com/login/device', 'OLD-1234');
      return waiting;
    });
    const app = await fixture({ login });
    await app.call('login', 'POST');
    expect(await app.status()).toHaveProperty('authorization.code', 'OLD-1234');
    expire(new LoginError('The device code expired. Start login again.'));
    await expect.poll(async () => (await app.status()).state).toBe('failed');
    expect(await app.status()).not.toHaveProperty('authorization');
    expect(app.save).not.toHaveBeenCalled();
    login.mockImplementationOnce(({ signal, display }) => new Promise((_resolve, reject) => {
      display('https://github.com/login/device', 'NEW-5678');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await app.call('login', 'POST');
    expect(await app.status()).toHaveProperty('authorization.code', 'NEW-5678');
  });

  it('reports device-code request failure and supports retry instead of remaining stuck', async () => {
    const app = await fixture({ login: async () => { throw new LoginError('Device code request failed.'); } });
    await app.call('login', 'POST');
    await expect.poll(async () => (await app.status()).state).toBe('failed');
    expect(await app.status()).toMatchObject({ busy: false, saved: false });
    expect(app.save).not.toHaveBeenCalled();
    expect((await app.call('login', 'POST')).status).toBe(202);
  });

  it('cancels polling when the last login page closes and refuses unattended login', async () => {
    const login = vi.fn<typeof deviceLogin>(({ signal, display }) => new Promise((_resolve, reject) => {
      display('https://github.com/login/device', 'ABCD-1234');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const app = await fixture({ login });
    await app.call('login', 'POST');
    expect(await app.status()).toHaveProperty('authorization');
    await app.closePage();
    await expect.poll(async () => (await app.status()).state).toBe('cancelled');
    expect(await app.status()).not.toHaveProperty('authorization');
    expect(app.save).not.toHaveBeenCalled();
    expect((await app.call('login', 'POST')).status).toBe(409);
  });

  it('does not save a token that arrives after its page disconnected', async () => {
    let authorize!: (value: string) => void;
    const authorized = new Promise<string>((resolve) => { authorize = resolve; });
    let signal: AbortSignal | undefined;
    const app = await fixture({ login: async (options) => { signal = options.signal; return authorized; } });
    await app.call('login', 'POST');
    await app.closePage();
    await expect.poll(() => signal?.aborted).toBe(true);
    authorize('late-synthetic-secret');
    await expect.poll(async () => (await app.status()).state).toBe('cancelled');
    expect(app.save).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated, cross-origin and rebound-host requests', async () => {
    const app = await fixture();
    expect((await fetch(`${app.url.origin}/api/login`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${app.url.origin}/api/login`, {
      method: 'POST', headers: { ...app.headers, origin: 'https://other.invalid' },
    })).status).toBe(403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(`${app.url.origin}/api/status`, {
        headers: { ...app.headers, host: 'rebound.invalid' },
      }, (response) => { response.resume(); resolve(response.statusCode); });
      outgoing.once('error', reject);
      outgoing.end();
    });
    expect(reboundStatus).toBe(403);
    expect((await fetch(`${app.url.origin}/terminal`, { headers: app.headers })).status).toBe(404);
    expect(app.save).not.toHaveBeenCalled();
  });
});
