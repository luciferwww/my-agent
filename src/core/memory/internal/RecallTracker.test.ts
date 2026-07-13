import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecallTracker } from './RecallTracker.js';

describe('RecallTracker', () => {
  let workspaceDir = '';

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'recall-tracker-'));
  });

  afterEach(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('writes recall entries as jsonl records', async () => {
    const recallDir = join(workspaceDir, '.agent', 'memory', '.recalls');
    const tracker = new RecallTracker(recallDir);

    tracker.record({
      query: 'find architecture notes',
      timestamp: '2026-04-07T10:00:00.000Z',
      results: [
        {
          path: 'memory/notes.md',
          startLine: 3,
          endLine: 9,
          score: 0.82,
        },
      ],
    });

    const logPath = join(recallDir, 'recall-log.jsonl');
    const content = await readFileEventually(logPath);
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      query: 'find architecture notes',
      timestamp: '2026-04-07T10:00:00.000Z',
      results: [
        {
          path: 'memory/notes.md',
          startLine: 3,
          endLine: 9,
          score: 0.82,
        },
      ],
    });
  });

  it('swallows write failures so record does not interrupt callers', async () => {
    const recallDir = join(workspaceDir, 'occupied-by-file');
    await writeFile(recallDir, 'not a directory', 'utf-8');

    const tracker = new RecallTracker(recallDir);

    expect(() => {
      tracker.record({
        query: 'noop',
        timestamp: '2026-04-07T10:00:00.000Z',
        results: [],
      });
    }).not.toThrow();
  });
});

async function readFileEventually(filePath: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}