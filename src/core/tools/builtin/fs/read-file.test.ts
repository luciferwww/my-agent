import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFileTool } from './read-file.js';

let workspaceDir = '';
const originalCwd = process.cwd();

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'read-file-tool-'));
  process.chdir(workspaceDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('readFileTool', () => {
  it('reads a whole small file by default', async () => {
    await writeFile(join(workspaceDir, 'note.txt'), 'line 1\nline 2\nline 3\n');

    const result = await readFileTool.execute({ path: 'note.txt' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('path: note.txt');
    expect(result.content).toContain('lines: 1-3 of 3');
    expect(result.content).toContain('line 1');
    expect(result.content).toContain('line 3');
  });

  it('reads a specific line range', async () => {
    await writeFile(join(workspaceDir, 'note.txt'), 'a\nb\nc\nd\n');

    const result = await readFileTool.execute({ path: 'note.txt', startLine: 2, endLine: 3 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('lines: 2-3 of 4');
    expect(result.content).toContain('\nb\nc');
    expect(result.content).not.toContain('\na\n');
  });

  it('returns an error for invalid line ranges', async () => {
    await writeFile(join(workspaceDir, 'note.txt'), 'a\nb\n');

    const result = await readFileTool.execute({ path: 'note.txt', startLine: 3, endLine: 2 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('startLine');
  });

  it('rejects paths outside the workspace', async () => {
    const result = await readFileTool.execute({ path: '..\\outside.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the workspace');
  });
});