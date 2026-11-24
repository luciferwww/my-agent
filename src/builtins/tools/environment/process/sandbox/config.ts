import { isAbsolute, normalize } from 'node:path';

export interface SandboxConfig {
  readonly enabled: boolean;
  readonly readonlyPaths: readonly string[];
  readonly readwritePaths: readonly string[];
  readonly deniedPaths: readonly string[];
}

export class SandboxConfigValidationError extends Error {
  constructor(readonly fieldPath: string) {
    super(`Invalid sandbox configuration: ${fieldPath || 'sandbox'}`);
    this.name = 'SandboxConfigValidationError';
  }
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = Object.freeze({
  enabled: false,
  readonlyPaths: Object.freeze([]),
  readwritePaths: Object.freeze([]),
  deniedPaths: Object.freeze([]),
});

export function resolveSandboxConfig(value: unknown = undefined): SandboxConfig {
  if (value === undefined) return DEFAULT_SANDBOX_CONFIG;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SandboxConfigValidationError('');
  }
  const fields = new Set(['enabled', 'readonlyPaths', 'readwritePaths', 'deniedPaths']);
  for (const name of Object.keys(value)) {
    if (!fields.has(name)) throw new SandboxConfigValidationError(name);
  }
  const enabled = 'enabled' in value ? value.enabled : false;
  if (typeof enabled !== 'boolean') throw new SandboxConfigValidationError('enabled');
  const suppliedFields: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));

  function paths(name: 'readonlyPaths' | 'readwritePaths' | 'deniedPaths'): readonly string[] {
    const supplied: unknown = name in suppliedFields ? suppliedFields[name] : undefined;
    if (supplied === undefined) return Object.freeze([]);
    if (!Array.isArray(supplied)) throw new SandboxConfigValidationError(name);
    return Object.freeze(supplied.map((entry: unknown, index: number) => {
      if (typeof entry !== 'string' || entry !== entry.trim() || !isAbsolute(entry)
        || entry.includes('\0') || entry.startsWith('\\\\')) {
        throw new SandboxConfigValidationError(`${name}[${index}]`);
      }
      return normalize(entry);
    }));
  }
  return Object.freeze({
    enabled,
    readonlyPaths: paths('readonlyPaths'),
    readwritePaths: paths('readwritePaths'),
    deniedPaths: paths('deniedPaths'),
  });
}
