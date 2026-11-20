import { afterEach, expect, it, vi } from 'vitest';
import * as auth from './auth.js';
import { FileCredentials } from './credentials.js';
import { LoginServer } from './login-server.js';
import * as platform from './platform.js';
import { main } from './standalone.js';

afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const start = vi.spyOn(LoginServer.prototype, 'start');
  const open = vi.spyOn(platform, 'openLoginPage').mockResolvedValue(undefined);
  const login = vi.spyOn(auth, 'deviceLogin').mockImplementation(async ({ display }) => {
    display('https://github.com/login/device', 'TEST-1234');
    return 'synthetic-github-token';
  });
  const verify = vi.spyOn(auth, 'verifyCopilot').mockResolvedValue(undefined);
  const save = vi.spyOn(FileCredentials.prototype, 'save').mockResolvedValue(undefined);
  return { output, start, open, login, verify, save };
}

it('logs in without a browser or local server and verifies access before saving', async () => {
  const app = fixture();
  let verified = false;
  app.verify.mockImplementation(async () => { verified = true; });
  app.save.mockImplementation(async (token) => {
    expect(verified).toBe(true);
    expect(token).toBe('synthetic-github-token');
  });
  await main(['--device-code']);
  expect(app.start).not.toHaveBeenCalled();
  expect(app.open).not.toHaveBeenCalled();
  expect(app.save).toHaveBeenCalledTimes(1);
  const text = app.output.mock.calls.map((args) => args.join(' ')).join('\n');
  expect(text).toContain('https://github.com/login/device');
  expect(text).toContain('TEST-1234');
  expect(text).not.toContain('synthetic-github-token');
});

it('does not replace saved credentials when Copilot verification fails', async () => {
  const app = fixture();
  app.verify.mockRejectedValue(new auth.LoginError('Copilot access rejected'));
  await expect(main(['--device-code'])).rejects.toThrow('Copilot access rejected');
  expect(app.save).not.toHaveBeenCalled();
});

it('cancels terminal authorization without saving and removes signal listeners', async () => {
  const app = fixture();
  const previous = process.listeners('SIGINT');
  app.login.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const cancelled = expect(main(['--device-code'])).rejects.toThrow('cancelled');
  const cancel = process.listeners('SIGINT').find((listener) => !previous.includes(listener));
  expect(cancel).toBeDefined();
  cancel?.('SIGINT');
  await cancelled;
  expect(app.verify).not.toHaveBeenCalled();
  expect(app.save).not.toHaveBeenCalled();
  expect(process.listeners('SIGINT')).toEqual(previous);
});
