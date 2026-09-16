import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createListDirTool } from './list-dir-tool.js';
import type { Tool } from '../../../../core/tools/types.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

let agentHome = '';
let listDirTool: Tool;

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), 'list-dir-tool-'));
  listDirTool = createListDirTool(agentHome);
});

afterEach(async () => {
  if (agentHome) {
    await rm(agentHome, { recursive: true, force: true });
  }
});

describe('listDirTool', () => {
  it('lists direct children for a directory', async () => {
    await mkdir(join(agentHome, 'src'));
    await writeFile(join(agentHome, 'README.md'), '# hello\n');

    const result = await listDirTool.execute({ path: '.' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('path: .');
    expect(result.content).toContain('README.md');
    expect(result.content).toContain('src/');
  });

  it('returns an error for a non-directory path', async () => {
    await writeFile(join(agentHome, 'note.txt'), 'hello');

    const result = await listDirTool.execute({ path: 'note.txt' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('path is not a directory');
  });

  it('allows an approved caller to list outside Agent Home', async () => {
    const result = await listDirTool.execute({ path: '..' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('success');
  });
});
