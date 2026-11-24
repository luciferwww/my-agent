import { isAbsolute, normalize, relative, sep } from 'node:path';

export interface SandboxConfig {
  readonly enabled: boolean;
  readonly network: 'none' | 'outbound' | 'outbound-and-loopback';
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly deny: readonly string[];
}

export class SandboxConfigValidationError extends Error {
  constructor(readonly fieldPath: string) {
    super(`Invalid sandbox configuration: ${fieldPath || 'sandbox'}`);
    this.name = 'SandboxConfigValidationError';
  }
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = Object.freeze({
  enabled: false,
  network: 'none',
  read: Object.freeze([]),
  write: Object.freeze([]),
  deny: Object.freeze([]),
});

export function resolveSandboxConfig(value: unknown = undefined): SandboxConfig {
  if (value === undefined) return DEFAULT_SANDBOX_CONFIG;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SandboxConfigValidationError('');
  }
  const fields = new Set(['enabled', 'network', 'read', 'write', 'deny']);
  for (const name of Object.keys(value)) {
    if (!fields.has(name)) throw new SandboxConfigValidationError(name);
  }
  const enabled = 'enabled' in value ? value.enabled : false;
  if (typeof enabled !== 'boolean') throw new SandboxConfigValidationError('enabled');
  const suppliedFields: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const network = suppliedFields.network === undefined ? 'none' : suppliedFields.network;
  if (network !== 'none' && network !== 'outbound' && network !== 'outbound-and-loopback') {
    throw new SandboxConfigValidationError('network');
  }

  function paths(name: 'read' | 'write' | 'deny'): readonly string[] {
    const supplied: unknown = name in suppliedFields ? suppliedFields[name] : undefined;
    if (supplied === undefined) return Object.freeze([]);
    if (!Array.isArray(supplied)) throw new SandboxConfigValidationError(name);
    return Object.freeze(supplied.map((entry: unknown, index: number) => {
      if (typeof entry !== 'string' || entry !== entry.trim() || !isAbsolute(entry)
        || entry.includes('\0') || entry.startsWith('\\\\')) {
        throw new SandboxConfigValidationError(`${name}[${index}]`);
      }
      const path = normalize(entry);
      if (process.platform === 'linux') {
        const temp = relative(path, '/tmp');
        if (temp === '' || (!isAbsolute(temp) && temp !== '..' && !temp.startsWith(`..${sep}`))) {
          throw new SandboxConfigValidationError(`${name}[${index}]`);
        }
      }
      return path;
    }));
  }
  return Object.freeze({
    enabled,
    network,
    read: paths('read'),
    write: paths('write'),
    deny: paths('deny'),
  });
}
