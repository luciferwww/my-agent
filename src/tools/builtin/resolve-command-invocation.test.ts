import { describe, expect, it } from 'vitest';

import { resolveCommandInvocation } from './resolve-command-invocation.js';

describe('resolveCommandInvocation', () => {
  it('builds an explicit cmd.exe wrapper on Windows', () => {
    const invocation = resolveCommandInvocation({
      command: 'node -e "console.log(\'hello\')"',
      cwd: 'C:/workspace',
      env: { FOO: 'bar' },
      platform: 'win32',
      comSpec: 'C:/Windows/System32/cmd.exe',
    });

    expect(invocation.file).toBe('C:/Windows/System32/cmd.exe');
    expect(invocation.args).toEqual(['/d', '/s', '/c', 'node -e "console.log(\'hello\')"']);
    expect(invocation.options.shell).toBe(false);
    expect(invocation.options.windowsHide).toBe(true);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
  });

  it('builds an explicit sh wrapper on Unix', () => {
    const invocation = resolveCommandInvocation({
      command: 'node -e "console.log(\'hello\')"',
      cwd: '/workspace',
      env: { FOO: 'bar' },
      detached: true,
      platform: 'linux',
      unixShell: '/bin/sh',
    });

    expect(invocation.file).toBe('/bin/sh');
    expect(invocation.args).toEqual(['-c', 'node -e "console.log(\'hello\')"']);
    expect(invocation.options.shell).toBe(false);
    expect(invocation.options.detached).toBe(true);
    expect(invocation.options.windowsHide).toBeUndefined();
  });

  it('defaults Unix invocations to detached process groups', () => {
    const invocation = resolveCommandInvocation({
      command: 'node -e "console.log(\'hello\')"',
      cwd: '/workspace',
      env: { FOO: 'bar' },
      platform: 'linux',
      unixShell: '/bin/sh',
    });

    expect(invocation.options.detached).toBe(true);
  });
});