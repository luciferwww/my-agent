/**
 * Platform shell-wrapper integration test.
 *
 * Verifies that exec still preserves platform shell semantics after moving
 * away from Node's implicit shell selection.
 *
 * Usage:
 *   npx tsx scripts/test-exec-platform-shell.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { createToolExecutor, execTool } from '../src/tools/index.js';

function normalizePathForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function getEnvExpansionCommand(): string {
  if (process.platform === 'win32') {
    return 'echo %PLATFORM_RUNTIME_SMOKE%';
  }

  return 'printf "%s\n" "$PLATFORM_RUNTIME_SMOKE"';
}

function getCwdBuiltinCommand(): string {
  if (process.platform === 'win32') {
    return 'cd . && echo %CD%';
  }

  return 'cd . && printf "%s\n" "$PWD"';
}

async function main(): Promise<void> {
  const toolExecutor = createToolExecutor([execTool]);
  const cwd = await mkdtemp(join(os.tmpdir(), 'my-agent-platform-shell-'));

  try {
    console.log('\nStarting platform shell-wrapper integration test');
    console.log(`platform: ${process.platform}`);
    console.log(`cwd: ${cwd}`);

    const marker = 'shell-wrapper-ok';
    const envResult = await toolExecutor('exec', {
      command: getEnvExpansionCommand(),
      cwd,
      env: {
        PLATFORM_RUNTIME_SMOKE: marker,
      },
    });

    assert.ok(!envResult.isError, `expected env expansion success, got: ${envResult.content}`);
    assert.match(envResult.content, new RegExp(marker));

    const cwdResult = await toolExecutor('exec', {
      command: getCwdBuiltinCommand(),
      cwd,
    });

    assert.ok(!cwdResult.isError, `expected cwd builtin success, got: ${cwdResult.content}`);
    assert.ok(
      normalizePathForCompare(cwdResult.content).includes(normalizePathForCompare(resolve(cwd))),
      `expected cwd output to include ${cwd}, got: ${cwdResult.content}`,
    );

    console.log('\nEnvironment expansion output:');
    console.log(envResult.content.trim());
    console.log('\nCWD builtin output:');
    console.log(cwdResult.content.trim());
    console.log('\nplatform shell-wrapper integration test complete\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();