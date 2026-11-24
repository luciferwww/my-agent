import { describe, expect, it } from 'vitest';
import { resolveSandboxConfig } from './config.js';

describe('sandbox configuration', () => {
  it('normalizes independent content grants without promoting cwd or a read-only conflict', () => {
    const root = process.cwd();
    const config = resolveSandboxConfig({ enabled: true, readonlyPaths: [root], readwritePaths: [root] });
    expect(config.readonlyPaths).toEqual([root]);
    expect(config.readwritePaths).toEqual([root]);
    expect(config.deniedPaths).toEqual([]);
    expect(Object.isFrozen(config.readonlyPaths)).toBe(true);
  });

  it.each([
    { value: { enabled: 'true' }, field: 'enabled' },
    { value: { readonlyPaths: ['relative'] }, field: 'readonlyPaths[0]' },
    { value: { readwritePaths: ['\\\\server\\share'] }, field: 'readwritePaths[0]' },
    { value: { deniedPaths: process.cwd() }, field: 'deniedPaths' },
    { value: { network: true }, field: 'network' },
  ])('rejects invalid or unsupported configuration at $field', ({ value, field }) => {
    expect(() => resolveSandboxConfig(value)).toThrow(`Invalid sandbox configuration: ${field}`);
  });
});
