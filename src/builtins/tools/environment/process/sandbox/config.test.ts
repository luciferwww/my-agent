import { describe, expect, it } from 'vitest';
import { resolveSandboxConfig } from './config.js';

describe('sandbox configuration', () => {
  it('normalizes independent content grants without promoting cwd or a read-only conflict', () => {
    const root = process.cwd();
    const config = resolveSandboxConfig({ enabled: true, read: [root], write: [root] });
    expect(config.read).toEqual([root]);
    expect(config.write).toEqual([root]);
    expect(config.deny).toEqual([]);
    expect(config.network).toBe('none');
    expect(resolveSandboxConfig().network).toBe('none');
    expect(Object.isFrozen(config.read)).toBe(true);
  });

  it.each([
    { value: { enabled: 'true' }, field: 'enabled' },
    { value: { read: ['relative'] }, field: 'read[0]' },
    { value: { write: ['\\\\server\\share'] }, field: 'write[0]' },
    { value: { deny: process.cwd() }, field: 'deny' },
    { value: { network: true }, field: 'network' },
    { value: { network: 'all' }, field: 'network' },
    { value: { network: null }, field: 'network' },
    { value: { readonlyPaths: [] }, field: 'readonlyPaths' },
    { value: { readwritePaths: [] }, field: 'readwritePaths' },
    { value: { deniedPaths: [] }, field: 'deniedPaths' },
  ])('rejects invalid or unsupported configuration at $field', ({ value, field }) => {
    expect(() => resolveSandboxConfig(value)).toThrow(`Invalid sandbox configuration: ${field}`);
  });

  it.skipIf(process.platform !== 'linux').each(['/', '/tmp'])(
    'rejects a host mount that would shadow private /tmp: %s', path => {
      expect(() => resolveSandboxConfig({ write: [path] })).toThrow('write[0]');
      expect(() => resolveSandboxConfig({ read: [path] })).toThrow('read[0]');
      expect(() => resolveSandboxConfig({ deny: [path] })).toThrow('deny[0]');
    },
  );
});
