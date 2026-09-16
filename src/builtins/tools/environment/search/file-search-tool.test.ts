import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSearchTool } from './file-search-tool.js';
import type { Tool } from '../../../../core/tools/types.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

let agentHome = '';
let fileSearchTool: Tool;

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), 'file-search-tool-'));
  fileSearchTool = createFileSearchTool(agentHome);
});

afterEach(async () => {
  if (agentHome) {
    await rm(agentHome, { recursive: true, force: true });
  }
});

describe('fileSearchTool', () => {
  it('finds files by substring', async () => {
    await mkdir(join(agentHome, 'src'), { recursive: true });
    await writeFile(join(agentHome, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
    await writeFile(join(agentHome, 'src', 'beta.ts'), 'export const beta = 1;\n');

    const result = await fileSearchTool.execute({ query: 'alpha' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('src/alpha.ts');
    expect(result.content).not.toContain('src/beta.ts');
  });

  it('supports glob-like patterns', async () => {
    await mkdir(join(agentHome, 'docs'), { recursive: true });
    await writeFile(join(agentHome, 'docs', 'one.md'), '# one\n');
    await writeFile(join(agentHome, 'docs', 'two.txt'), 'two\n');

    const result = await fileSearchTool.execute({ query: 'docs/*.md' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('docs/one.md');
    expect(result.content).not.toContain('docs/two.txt');
  });

  it('searches from an optional per-call root', async () => {
    await mkdir(join(agentHome, 'selected', 'src'), { recursive: true });
    await mkdir(join(agentHome, 'other'), { recursive: true });
    await writeFile(join(agentHome, 'selected', 'src', 'alpha.ts'), 'selected\n');
    await writeFile(join(agentHome, 'other', 'alpha.ts'), 'other\n');

    const result = await fileSearchTool.execute({
      query: 'alpha',
      path: 'selected',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('src/alpha.ts');
    expect(result.content).not.toContain('other/alpha.ts');
  });
});
