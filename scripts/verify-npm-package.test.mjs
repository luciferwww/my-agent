import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertTreeUnchanged,
  collectChild,
  connectWithRetry,
  createIsolatedHomeEnvironment,
  redactSubprocessOutput,
  snapshotTree,
} from './verify-npm-package.mjs';

describe('npm package verification boundaries', () => {
  it('redacts the working directory and sensitive environment values', () => {
    const output = 'failed in C:\\temporary with token-value and ordinary-value';

    expect(redactSubprocessOutput(output, 'C:\\temporary', {
      NODE_AUTH_TOKEN: 'token-value',
      ORDINARY_SETTING: 'ordinary-value',
    })).toBe('failed in <working-directory> with <redacted> and ordinary-value');
  });

  it('constructs an isolated environment from standard Home variables', () => {
    expect(createIsolatedHomeEnvironment('C:\\isolated-home', {
      PATH: 'ordinary-path',
      HOME: 'old-home',
      USERPROFILE: 'old-profile',
    })).toEqual({
      PATH: 'ordinary-path',
      HOME: 'C:\\isolated-home',
      USERPROFILE: 'C:\\isolated-home',
    });
  });

  it('snapshots relative file paths and bytes for immutability checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-agent-package-snapshot-'));
    try {
      await mkdir(join(root, 'nested'));
      await writeFile(join(root, 'nested', 'value.txt'), 'before');
      const before = await snapshotTree(root);

      expect(before).toEqual({
        nested: 'directory',
        [join('nested', 'value.txt')]: `file:${Buffer.from('before').toString('base64')}`,
      });
      expect(() => assertTreeUnchanged(before, { ...before }, 'Tree')).not.toThrow();

      await writeFile(join(root, 'nested', 'value.txt'), 'after');
      const after = await snapshotTree(root);
      expect(() => assertTreeUnchanged(before, after, 'Tree'))
        .toThrow('Tree changed during Runtime operation.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds a WebSocket attempt whose peer never completes the handshake', async () => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test server port.');

    try {
      await expect(connectWithRetry(
        `ws://127.0.0.1:${address.port}`,
        { exitCode: null, signalCode: null },
        100,
      )).rejects.toThrow('startup timed out');
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    }
  });

  it('terminates a timed-out subprocess and its descendant within the cleanup boundary', async () => {
    const child = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });",
      'console.log(descendant.pid);',
      'setInterval(() => undefined, 1000);',
    ].join(' ')], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const descendantPid = once(child.stdout, 'data').then(([chunk]) => {
      const match = /\d+/u.exec(chunk.toString());
      return match === null ? Number.NaN : Number(match[0]);
    });
    const result = collectChild(child, 250);

    await expect(result).rejects.toThrow('timed out');
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    const pid = await descendantPid;
    expect(Number.isSafeInteger(pid)).toBe(true);
    await expect(waitForProcessExit(pid, 1_000)).resolves.toBe(true);
  });
});

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}
