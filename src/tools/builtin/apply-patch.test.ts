import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPatchTool } from './apply-patch.js';

let workspaceDir = '';
const originalCwd = process.cwd();

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'apply-patch-tool-'));
  process.chdir(workspaceDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('applyPatchTool', () => {
  it('adds a file', async () => {
    const result = await applyPatchTool.execute({
      input: `*** Begin Patch\n*** Add File: added.txt\n+hello\n+world\n*** End Patch`,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('A added.txt');
    expect(await readFile(join(workspaceDir, 'added.txt'), 'utf8')).toBe('hello\nworld\n');
  });

  it('updates a file with context lines', async () => {
    await writeFile(join(workspaceDir, 'sample.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

    const result = await applyPatchTool.execute({
      input: `*** Begin Patch\n*** Update File: sample.txt\n@@\n alpha\n-beta\n+beta-updated\n gamma\n*** End Patch`,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('M sample.txt');
    expect(await readFile(join(workspaceDir, 'sample.txt'), 'utf8')).toBe('alpha\nbeta-updated\ngamma\n');
  });

  it('deletes a file', async () => {
    await writeFile(join(workspaceDir, 'obsolete.txt'), 'remove me\n', 'utf8');

    const result = await applyPatchTool.execute({
      input: `*** Begin Patch\n*** Delete File: obsolete.txt\n*** End Patch`,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('D obsolete.txt');
  });
});