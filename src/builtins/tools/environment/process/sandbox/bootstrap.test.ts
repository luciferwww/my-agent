import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseBootstrapRequest, prepareChildEnvironment, ROOT_VARIABLE,
  superviseChild, validateCommandEnvironment,
} from './bootstrap.js';

afterEach(() => vi.useRealTimers());

describe('sandbox bootstrap', () => {
  it('keeps intentional Node hooks in the command environment and rejects reserved/case-duplicate values', () => {
    expect(validateCommandEnvironment({ NODE_OPTIONS: '--require ./hook.cjs' }))
      .toEqual({ NODE_OPTIONS: '--require ./hook.cjs' });
    if (process.platform === 'win32') {
      expect(() => validateCommandEnvironment({ temp: 'other' })).toThrow('Reserved');
      expect(() => validateCommandEnvironment({ CUSTOM: 'one', custom: 'two' })).toThrow('Duplicate');
    } else {
      expect(validateCommandEnvironment({ home: 'other', CUSTOM: 'one', custom: 'two' }))
        .toEqual({ home: 'other', CUSTOM: 'one', custom: 'two' });
      expect(() => validateCommandEnvironment({ HOME: 'other' })).toThrow('Reserved');
    }
    expect(() => parseBootstrapRequest('{"command":"x","root":"x","environment":{}}')).toThrow('Invalid');
  });

  it('prepares owned paths but rejects a reparse/symlink escape before creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mxc-bootstrap-test-'));
    const outside = await mkdtemp(join(tmpdir(), 'mxc-bootstrap-outside-'));
    try {
      await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      const environment = { [ROOT_VARIABLE]: root, TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), LOCALAPPDATA: join(root, 'data') };
      const result = prepareChildEnvironment({ command: 'x', root, environment: { NODE_OPTIONS: '--require ./hook.cjs' } }, environment);
      expect(result.NODE_OPTIONS).toBe('--require ./hook.cjs');
      expect(result[ROOT_VARIABLE]).toBeUndefined();
      if (process.platform === 'win32') {
        expect(() => prepareChildEnvironment({ command: 'x', root, environment: {} },
          { ...environment, TEMP: join(root, 'link', 'not-created') })).toThrow('outside');
      } else {
        expect(() => prepareChildEnvironment({ command: 'x', root: root.toUpperCase(), environment: {} }, environment))
          .toThrow('does not match');
        expect(result.TMPDIR).toBe('/tmp');
        expect(result.SHELL).toBe('/bin/sh');
        expect(result).not.toHaveProperty('USERPROFILE');
        await rm(join(root, 'home'), { recursive: true });
        await symlink(outside, join(root, 'home'), 'dir');
        expect(() => prepareChildEnvironment({ command: 'x', root, environment: {} }, environment))
          .toThrow('outside');
      }
    } finally {
      await rm(join(root, 'link'), { force: true });
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails precisely at the output-drain boundary after Shell exit zero', async () => {
    vi.useFakeTimers();
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 123 });
    const childOutput = new PassThrough();
    child.stdout = childOutput;
    child.stderr = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', chunk => { stdout += chunk.toString(); });
    errors.on('data', chunk => { stderr += chunk.toString(); });
    const exit = vi.fn();
    superviseChild(child, output, errors, exit);
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(0);
    childOutput.write('partial output');
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout).toContain('partial output');
    expect(stderr).toContain('output incomplete');
    expect(stderr).toContain('Shell exit code: 0');
    output.destroy();
    errors.destroy();
  });
});
