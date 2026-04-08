import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listDirTool } from './list-dir.js';

let workspaceDir = '';
const originalCwd = process.cwd();

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'list-dir-tool-'));
  process.chdir(workspaceDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('listDirTool', () => {
  it('lists direct children for a directory', async () => {
    await mkdir(join(workspaceDir, 'src'));
    await writeFile(join(workspaceDir, 'README.md'), '# hello\n');

    const result = await listDirTool.execute({ path: '.' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('path: .');
    expect(result.content).toContain('README.md');
    expect(result.content).toContain('src/');
  });

  it('returns an error for a non-directory path', async () => {
    await writeFile(join(workspaceDir, 'note.txt'), 'hello');

    const result = await listDirTool.execute({ path: 'note.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('path is not a directory');
  });

  it('rejects paths outside the workspace', async () => {
    const result = await listDirTool.execute({ path: '..' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the workspace');
  });
});