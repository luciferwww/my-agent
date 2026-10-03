import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEditFileTool } from './edit-file-tool.js';
import type { Tool } from '../../../../core/tools/types.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

let agentHome = '';
let editFileTool: Tool;

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), 'edit-file-tool-'));
  editFileTool = createEditFileTool(agentHome);
});

afterEach(async () => {
  if (agentHome) {
    await rm(agentHome, { recursive: true, force: true });
  }
});

describe('editFileTool', () => {
  it('replaces one exact occurrence', async () => {
    await writeFile(join(agentHome, 'sample.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await editFileTool.execute({
      path: 'sample.txt',
      oldText: 'beta',
      newText: 'beta-updated',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('replacements: 1');
    expect(await readFile(join(agentHome, 'sample.txt'), 'utf8')).toContain('beta-updated');
  });

  it('returns an error when oldText is missing', async () => {
    await writeFile(join(agentHome, 'sample.txt'), 'alpha\n', 'utf8');

    const result = await editFileTool.execute({
      path: 'sample.txt',
      oldText: 'beta',
      newText: 'gamma',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('oldText not found');
  });

  it('returns an error when oldText matches multiple times', async () => {
    await writeFile(join(agentHome, 'sample.txt'), 'beta\nbeta\n', 'utf8');

    const result = await editFileTool.execute({
      path: 'sample.txt',
      oldText: 'beta',
      newText: 'gamma',
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('matched 2 times');
  });
});
