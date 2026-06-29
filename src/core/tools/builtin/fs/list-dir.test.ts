import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createListDirTool } from './list-dir.js';
import type { Tool } from '../../types.js';
import { TEST_TOOL_CONTEXT } from '../../test-utils.js';

let workspaceDir = '';
let listDirTool: Tool;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'list-dir-tool-'));
  listDirTool = createListDirTool(workspaceDir);
});

afterEach(async () => {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('listDirTool', () => {
  it('lists direct children for a directory', async () => {
    await mkdir(join(workspaceDir, 'src'));
    await writeFile(join(workspaceDir, 'README.md'), '# hello\n');

    const result = await listDirTool.execute({ path: '.' }, TEST_TOOL_CONTEXT);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('path: .');
    expect(result.content).toContain('README.md');
    expect(result.content).toContain('src/');
  });

  it('returns an error for a non-directory path', async () => {
    await writeFile(join(workspaceDir, 'note.txt'), 'hello');

    const result = await listDirTool.execute({ path: 'note.txt' }, TEST_TOOL_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('path is not a directory');
  });

  it('rejects paths outside the workspace', async () => {
    const result = await listDirTool.execute({ path: '..' }, TEST_TOOL_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the workspace');
  });
});
