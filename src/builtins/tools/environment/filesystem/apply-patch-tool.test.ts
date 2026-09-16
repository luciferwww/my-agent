import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApplyPatchTool } from './apply-patch-tool.js';
import type { Tool } from '../../../../core/tools/types.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

let agentHome = '';
let applyPatchTool: Tool;

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), 'apply-patch-tool-'));
  applyPatchTool = createApplyPatchTool(agentHome);
});

afterEach(async () => {
  if (agentHome) {
    await rm(agentHome, { recursive: true, force: true });
  }
});

describe('applyPatchTool', () => {
  it('adds a file', async () => {
    const result = await applyPatchTool.execute({
      input: `*** Begin Patch\n*** Add File: added.txt\n+hello\n+world\n*** End Patch`,
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('A added.txt');
    expect(await readFile(join(agentHome, 'added.txt'), 'utf8')).toBe('hello\nworld\n');
  });

  it('updates a file with context lines', async () => {
    await writeFile(join(agentHome, 'sample.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await applyPatchTool.execute({
      input: `*** Begin Patch\n*** Update File: sample.txt\n@@\n alpha\n-beta\n+beta-updated\n gamma\n*** End Patch`,
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('M sample.txt');
    expect(await readFile(join(agentHome, 'sample.txt'), 'utf8')).toBe('alpha\nbeta-updated\ngamma\n');
  });

  it('deletes a file', async () => {
    await writeFile(join(agentHome, 'obsolete.txt'), 'remove me\n', 'utf8');

    const result = await applyPatchTool.execute({
      input: `*** Begin Patch\n*** Delete File: obsolete.txt\n*** End Patch`,
    }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('D obsolete.txt');
  });
});
