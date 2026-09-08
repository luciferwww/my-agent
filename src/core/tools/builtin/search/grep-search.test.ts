import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGrepSearchTool } from './grep-search.js';
import type { Tool } from '../../types.js';
import { TEST_TOOL_CONTEXT } from '../../test-utils.js';

let workspaceDir = '';
let grepSearchTool: Tool;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'grep-search-tool-'));
  grepSearchTool = createGrepSearchTool(workspaceDir);
});

afterEach(async () => {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('grepSearchTool', () => {
  it('finds plain-text matches', async () => {
    await mkdir(join(workspaceDir, 'src'), { recursive: true });
    await writeFile(join(workspaceDir, 'src', 'alpha.ts'), 'const token = 123;\nconst other = 456;\n');

    const result = await grepSearchTool.execute({ query: 'token', isRegexp: false }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('src/alpha.ts:1: const token = 123;');
  });

  it('supports regex search with includePattern', async () => {
    await mkdir(join(workspaceDir, 'src'), { recursive: true });
    await writeFile(join(workspaceDir, 'src', 'alpha.ts'), 'const value = 123;\n');
    await writeFile(join(workspaceDir, 'notes.txt'), 'value = 999\n');

    const result = await grepSearchTool.execute({
      query: 'value\\s*=\\s*\\d+',
      isRegexp: true,
      includePattern: 'src/*.ts',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('src/alpha.ts:1: const value = 123;');
    expect(result.content).not.toContain('notes.txt');
  });
});
