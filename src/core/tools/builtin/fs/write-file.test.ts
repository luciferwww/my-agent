import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWriteFileTool } from './write-file.js';
import type { Tool } from '../../types.js';
import { TEST_TOOL_CONTEXT } from '../../test-utils.js';

let workspaceDir = '';
let writeFileTool: Tool;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'write-file-tool-'));
  writeFileTool = createWriteFileTool(workspaceDir);
});

afterEach(async () => {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

describe('writeFileTool', () => {
  it('creates a new file', async () => {
    const result = await writeFileTool.execute({ path: 'notes/new.txt', content: 'hello\n' }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('created: true');
    expect(await readFile(join(workspaceDir, 'notes', 'new.txt'), 'utf8')).toBe('hello\n');
  });

  it('overwrites an existing file', async () => {
    await writeFileTool.execute({ path: 'notes.txt', content: 'old\n' }, TEST_TOOL_CONTEXT);
    const result = await writeFileTool.execute({ path: 'notes.txt', content: 'new\n' }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('created: false');
    expect(await readFile(join(workspaceDir, 'notes.txt'), 'utf8')).toBe('new\n');
  });
});
