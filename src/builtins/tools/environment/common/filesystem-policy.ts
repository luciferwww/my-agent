import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SandboxConfig } from '../process/sandbox/config.js';

type Access = 'read' | 'write';
type RuleKind = Access | 'deny';
const priority: Record<RuleKind, number> = { write: 1, read: 2, deny: 3 };

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function canonicalPath(path: string, follow = true): Promise<string> {
  const target = resolve(path);
  if (!follow) {
    const parent = dirname(target);
    return parent === target ? realpath(target) : join(await canonicalPath(parent), basename(target));
  }
  try {
    return await realpath(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // A dangling link is not a missing regular path whose tail can be appended.
    try {
      await lstat(target);
    } catch (entryError) {
      if (!isMissing(entryError)) throw entryError;
      const parent = dirname(target);
      if (parent === target) throw error;
      return join(await canonicalPath(parent), basename(target));
    }
    throw error;
  }
}

function identity(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function contains(root: string, target: string): boolean {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

export interface FilesystemPolicy {
  assert(path: string, access: Access, target?: 'follow' | 'entry'): Promise<void>;
  canRead(path: string): Promise<boolean>;
  assertWrite(path: string, target?: 'follow' | 'entry'): Promise<void>;
}

export function createFilesystemPolicy(
  config: SandboxConfig | undefined,
  dependencyReads: readonly string[] = [],
): FilesystemPolicy | undefined {
  if (!config?.enabled) return undefined;
  const rules = [
    ...[...dependencyReads, ...config.read].map(path => ({ path, kind: 'read' as const })),
    ...config.write.map(path => ({ path, kind: 'write' as const })),
    ...config.deny.map(path => ({ path, kind: 'deny' as const })),
  ];

  async function accessFor(path: string, entry = false): Promise<RuleKind> {
    const target = identity(await canonicalPath(path, !entry));
    let best: { length: number; kind: RuleKind } = { length: -1, kind: 'deny' };
    // Policy configuration is fixed, but aliases can change between operations.
    for (const rule of rules) {
      const entryPath = entry ? identity(await canonicalPath(rule.path, false)) : undefined;
      const root = entryPath === target ? target : identity(await canonicalPath(rule.path));
      if (contains(root, target)
        && (root.length > best.length || (root.length === best.length && priority[rule.kind] > priority[best.kind]))) {
        best = { length: root.length, kind: rule.kind };
      }
    }
    return best.kind;
  }

  async function assert(path: string, access: Access, target: 'follow' | 'entry' = 'follow'): Promise<void> {
    const kind = await accessFor(path, target === 'entry');
    if (kind === 'deny' || (access === 'write' && kind !== 'write')) {
      throw new Error(`Sandbox filesystem policy rejects ${access}: ${path}`);
    }
  }

  return {
    assert,
    async canRead(path) { return await accessFor(path) !== 'deny'; },
    async assertWrite(path, target = 'follow') {
      await assert(path, 'write', target);
      let parent = dirname(await canonicalPath(path, target === 'follow'));
      while (true) {
        try {
          if (!(await stat(parent)).isDirectory()) throw new Error(`Not a directory: ${parent}`);
          break;
        } catch (error) {
          if (!isMissing(error)) throw error;
          await assert(parent, 'write');
          const next = dirname(parent);
          if (next === parent) throw error;
          parent = next;
        }
      }
    },
  };
}
