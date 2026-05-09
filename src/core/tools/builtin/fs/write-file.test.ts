import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileTool } from './write-file.js';

let workspaceDir = '';
const originalCwd = process.cwd();

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'write-file-tool-'));
  process.chdir(workspaceDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('writeFileTool', () => {
  it('creates a new file', async () => {
    const result = await writeFileTool.execute({ path: 'notes/new.txt', content: 'hello\n' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('created: true');
    expect(await readFile(join(workspaceDir, 'notes', 'new.txt'), 'utf8')).toBe('hello\n');
  });

  it('overwrites an existing file', async () => {
    await writeFileTool.execute({ path: 'notes.txt', content: 'old\n' });
    const result = await writeFileTool.execute({ path: 'notes.txt', content: 'new\n' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('created: false');
    expect(await readFile(join(workspaceDir, 'notes.txt'), 'utf8')).toBe('new\n');
  });
});