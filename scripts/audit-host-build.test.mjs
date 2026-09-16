import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditHostBuild } from './audit-host-build.mjs';

describe('Host build audit', () => {
  it('accepts a closed Host tree with builtins and declared runtime packages', async () => {
    await withHostBuild({
      'hosts/standalone/entry.js': "#!/usr/bin/env node\nimport 'node:path'; import 'ws'; import '../../extension-acquisition/index.js';\n",
      'extension-acquisition/index.js': "export { load } from './loader.js';\n",
      'extension-acquisition/loader.js': 'export const load = () => [];\n',
      ...hostAssets(),
    }, async (root) => {
      await expect(auditHostBuild(root)).resolves.toContain('hosts/standalone/entry.js');
    });
  });

  it('rejects concrete Extension output and identity', async () => {
    await withHostBuild({
      'hosts/standalone/entry.js': "import '../../extension-acquisition/index.js';\n",
      'extension-acquisition/index.js': 'export const marker = "COPILOT_RELAY_";\n',
      'extensions/example/index.js': 'export {};\n',
      ...hostAssets(),
    }, async (root) => {
      await expect(auditHostBuild(root)).rejects.toThrow(/concrete Extension/u);
    });
  });

  it('rejects unresolved relative imports, including literal dynamic imports', async () => {
    await withHostBuild({
      'hosts/standalone/entry.js': "import('../../missing.js'); import '../../extension-acquisition/index.js';\n",
      'extension-acquisition/index.js': 'export {};\n',
      ...hostAssets(),
    }, async (root) => {
      await expect(auditHostBuild(root)).rejects.toThrow(/unresolved or escaping relative import/u);
    });
  });

  it('rejects undeclared runtime packages', async () => {
    await withHostBuild({
      'hosts/standalone/entry.js': "import 'undeclared-package/subpath'; import '../../extension-acquisition/index.js';\n",
      'extension-acquisition/index.js': 'export {};\n',
      ...hostAssets(),
    }, async (root) => {
      await expect(auditHostBuild(root)).rejects.toThrow(/undeclared runtime package/u);
    });
  });

  it('rejects a standalone entry without the Node executable shebang', async () => {
    await withHostBuild({
      'hosts/standalone/entry.js': "import '../../extension-acquisition/index.js';\n",
      'extension-acquisition/index.js': 'export {};\n',
      ...hostAssets(),
    }, async (root) => {
      await expect(auditHostBuild(root)).rejects.toThrow(/executable shebang/u);
    });
  });
});

function hostAssets() {
  return Object.fromEntries(
    ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md'].map((name) => [
      `core/agent-context/templates/${name}`,
      `# ${name}\n`,
    ]),
  );
}

async function withHostBuild(files, assertion) {
  const root = await mkdtemp(join(tmpdir(), 'my-agent-host-audit-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { ws: '*' } }));
    for (const [relativePath, content] of Object.entries(files)) {
      const path = join(root, 'dist', 'host', ...relativePath.split('/'));
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    }
    await assertion(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
