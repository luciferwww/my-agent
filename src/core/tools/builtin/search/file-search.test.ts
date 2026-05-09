import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileSearchTool } from './file-search.js';

let workspaceDir = '';
const originalCwd = process.cwd();

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'file-search-tool-'));
  process.chdir(workspaceDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('fileSearchTool', () => {
  it('finds files by substring', async () => {
    await mkdir(join(workspaceDir, 'src'), { recursive: true });
    await writeFile(join(workspaceDir, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
    await writeFile(join(workspaceDir, 'src', 'beta.ts'), 'export const beta = 1;\n');

    const result = await fileSearchTool.execute({ query: 'alpha' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/alpha.ts');
    expect(result.content).not.toContain('src/beta.ts');
  });

  it('supports glob-like patterns', async () => {
    await mkdir(join(workspaceDir, 'docs'), { recursive: true });
    await writeFile(join(workspaceDir, 'docs', 'one.md'), '# one\n');
    await writeFile(join(workspaceDir, 'docs', 'two.txt'), 'two\n');

    const result = await fileSearchTool.execute({ query: 'docs/*.md' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('docs/one.md');
    expect(result.content).not.toContain('docs/two.txt');
  });
});