import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const bootstrapPath = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts') ? './bootstrap.ts' : './bootstrap.js', import.meta.url,
));

export async function getSandboxDependencyReads(): Promise<readonly string[]> {
  const reads = [bootstrapPath, dirname(process.execPath)];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
    reads.push(join(systemRoot, 'System32'));
  } else if (process.platform === 'linux') {
    // Linux npm's bin entry points outside the Node executable directory.
    const npmLibrary = resolve(dirname(process.execPath), '../lib/node_modules/npm');
    try {
      if ((await stat(npmLibrary)).isDirectory()) reads.push(npmLibrary);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  // Node selects the bootstrap's module type from its nearest package manifest.
  let directory = dirname(bootstrapPath);
  while (true) {
    const manifest = join(directory, 'package.json');
    try {
      if ((await stat(manifest)).isFile()) {
        reads.push(manifest);
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return Object.freeze(reads);
}
