import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWriteFileTool } from './write-file-tool.js';
import type { Tool } from '../../../../core/tools/types.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

let agentHome = '';
let writeFileTool: Tool;

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), 'write-file-tool-'));
  writeFileTool = createWriteFileTool(agentHome);
});

afterEach(async () => {
  if (agentHome) {
    await rm(agentHome, { recursive: true, force: true });
  }
});

describe('writeFileTool', () => {
  it('creates a new file', async () => {
    const result = await writeFileTool.execute({ path: 'notes/new.txt', content: 'hello\n' }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('created: true');
    expect(await readFile(join(agentHome, 'notes', 'new.txt'), 'utf8')).toBe('hello\n');
  });

  it('overwrites an existing file', async () => {
    await writeFileTool.execute({ path: 'notes.txt', content: 'old\n' }, TEST_TOOL_CONTEXT);
    const result = await writeFileTool.execute({ path: 'notes.txt', content: 'new\n' }, TEST_TOOL_CONTEXT);

    expect(result.outcome).toBe('success');
    expect(result.content).toContain('created: false');
    expect(await readFile(join(agentHome, 'notes.txt'), 'utf8')).toBe('new\n');
  });
});
