import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editFileTool } from './edit-file.js';

let workspaceDir = '';
const originalCwd = process.cwd();

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'edit-file-tool-'));
  process.chdir(workspaceDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('editFileTool', () => {
  it('replaces one exact occurrence', async () => {
    await writeFile(join(workspaceDir, 'sample.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await editFileTool.execute({
      path: 'sample.txt',
      oldText: 'beta',
      newText: 'beta-updated',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('replacements: 1');
    expect(await readFile(join(workspaceDir, 'sample.txt'), 'utf8')).toContain('beta-updated');
  });

  it('returns an error when oldText is missing', async () => {
    await writeFile(join(workspaceDir, 'sample.txt'), 'alpha\n', 'utf8');

    const result = await editFileTool.execute({
      path: 'sample.txt',
      oldText: 'beta',
      newText: 'gamma',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('oldText not found');
  });

  it('returns an error when oldText matches multiple times', async () => {
    await writeFile(join(workspaceDir, 'sample.txt'), 'beta\nbeta\n', 'utf8');

    const result = await editFileTool.execute({
      path: 'sample.txt',
      oldText: 'beta',
      newText: 'gamma',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('matched 2 times');
  });
});