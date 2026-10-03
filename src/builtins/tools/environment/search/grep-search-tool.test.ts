import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGrepSearchTool } from './grep-search-tool.js';
import type { Tool } from '../../../../core/tools/types.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

let agentHome = '';
let grepSearchTool: Tool;

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), 'grep-search-tool-'));
  grepSearchTool = createGrepSearchTool(agentHome);
});

afterEach(async () => {
  if (agentHome) {
    await rm(agentHome, { recursive: true, force: true });
  }
});

describe('grepSearchTool', () => {
  it('finds plain-text matches', async () => {
    await mkdir(join(agentHome, 'src'), { recursive: true });
    await writeFile(join(agentHome, 'src', 'alpha.ts'), 'const token = 123;\nconst other = 456;\n');

    const result = await grepSearchTool.execute({ query: 'token', isRegexp: false }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('src/alpha.ts:1: const token = 123;');
  });

  it('supports regex search with includePattern', async () => {
    await mkdir(join(agentHome, 'src'), { recursive: true });
    await writeFile(join(agentHome, 'src', 'alpha.ts'), 'const value = 123;\n');
    await writeFile(join(agentHome, 'notes.txt'), 'value = 999\n');

    const result = await grepSearchTool.execute({
      query: 'value\\s*=\\s*\\d+',
      isRegexp: true,
      includePattern: 'src/*.ts',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('src/alpha.ts:1: const value = 123;');
    expect(result.content).not.toContain('notes.txt');
  });

  it('searches from an optional per-call root', async () => {
    await mkdir(join(agentHome, 'selected'), { recursive: true });
    await mkdir(join(agentHome, 'other'), { recursive: true });
    await writeFile(join(agentHome, 'selected', 'match.txt'), 'needle\n');
    await writeFile(join(agentHome, 'other', 'match.txt'), 'needle\n');

    const result = await grepSearchTool.execute({
      query: 'needle',
      isRegexp: false,
      path: 'selected',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('match.txt:1: needle');
    expect(result.content).not.toContain('other/match.txt');
  });
});
