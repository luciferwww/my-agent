import { ChildProcess, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { openLoginPage } from './platform.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  platform: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); });

const url = 'http://127.0.0.1:12345/#synthetic-page-key';
it.each([
  { os: 'win32' as const, command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
  { os: 'darwin' as const, command: 'open', args: [url] },
  { os: 'linux' as const, command: 'xdg-open', args: [url] },
])('opens the local page with the $os launcher and checks its exit status', async ({ os, command, args }) => {
  vi.mocked(platform).mockReturnValue(os);
  const child = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(child);
  const opening = openLoginPage(url);
  expect(spawn).toHaveBeenCalledWith(command, args, expect.objectContaining({ stdio: 'ignore' }));
  child.emit('close', 0);
  await opening;
});

it.each(['error', 'exit'] as const)('reports launcher %s failures with headless login instructions', async (failure) => {
  vi.mocked(platform).mockReturnValue('linux');
  const child = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(child);
  const rejected = expect(openLoginPage(url)).rejects.toThrow('--device-code');
  if (failure === 'error') child.emit('error', new Error('synthetic-private-launcher-detail'));
  else child.emit('close', 1);
  await rejected;
});
