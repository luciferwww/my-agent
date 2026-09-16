import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { killProcessTree } from './kill-process-tree.js';

describe('killProcessTree operating-system integration', () => {
  let parent: ChildProcess | undefined;
  let descendantPid: number | undefined;

  afterEach(async () => {
    if (parent?.pid && isProcessAlive(parent.pid)) {
      await killProcessTree({ pid: parent.pid, child: parent, reason: 'manual', graceMs: 0 });
    }
    if (descendantPid && isProcessAlive(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Process already exited.
      }
    }
  });

  it('terminates a real parent process and its descendant', async () => {
    const childProgram = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'console.log(child.pid);',
      'setInterval(() => {}, 1000);',
    ].join(' ');

    parent = spawn(process.execPath, ['-e', childProgram], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    descendantPid = await readPid(parent);
    expect(isProcessAlive(parent.pid!)).toBe(true);
    expect(isProcessAlive(descendantPid)).toBe(true);

    const result = await killProcessTree({
      pid: parent.pid,
      child: parent,
      reason: 'manual',
      graceMs: 50,
    });

    expect(result.ok).toBe(true);
    await waitFor(() => !isProcessAlive(parent!.pid!) && !isProcessAlive(descendantPid!), 5_000);
  }, 10_000);
});

function readPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for descendant pid')), 5_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
      const firstLine = output.split(/\r?\n/, 1)[0]?.trim();
      if (!firstLine || !/^\d+$/.test(firstLine)) {
        return;
      }

      clearTimeout(timeout);
      resolve(Number(firstLine));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for process tree termination');
}
