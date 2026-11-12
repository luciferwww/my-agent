import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProcessRecord } from './exec-types.js';
import { killProcessTree } from './kill-process-tree.js';
import { processTool } from './process-tool.js';
import { processRegistry } from './process-registry.js';
import { TEST_TOOL_CONTEXT } from '../../../../core/tools/test-utils.js';

vi.mock('./kill-process-tree.js', () => ({
  killProcessTree: vi.fn(),
}));

function registerProcess(update: Partial<ProcessRecord> = {}): string {
  const record: ProcessRecord = {
    runId: 'managed-process',
    sessionId: TEST_TOOL_CONTEXT.sessionId,
    command: 'background-command',
    cwd: process.cwd(),
    env: {},
    status: 'running',
    visibility: 'background',
    createdAt: 1,
    pid: 123,
    chunks: [],
    output: '',
    ...update,
  };
  processRegistry.create(record);
  return record.runId;
}

beforeEach(() => {
  vi.mocked(killProcessTree).mockReset();
  vi.mocked(killProcessTree).mockResolvedValue({
    ok: true, attemptedForce: false, method: 'child-kill',
  });
});

afterEach(() => {
  processRegistry.reset();
});

describe('processTool', () => {
  it('lists visible background processes', async () => {
    const runId = registerProcess();
    const list = await processTool.execute({ action: 'list' }, TEST_TOOL_CONTEXT);
    expect(list.content).toContain(runId);
  });

  it('returns logs for a background process', async () => {
    const runId = registerProcess({ output: 'background-log\n' });
    const logs = await processTool.execute({ action: 'log', runId }, TEST_TOOL_CONTEXT);
    expect(logs.content).toContain('background-log');
  });

  it('kills a running background process', async () => {
    const runId = registerProcess();
    vi.mocked(killProcessTree).mockImplementation(async () => {
      // Windows process exit can reach the registry before manual kill returns.
      processRegistry.complete(runId, { status: 'failed', endedAt: 2, exitCode: 1 });
      return { ok: true, attemptedForce: true, method: 'windows-taskkill' };
    });

    const killed = await processTool.execute({ action: 'kill', runId }, TEST_TOOL_CONTEXT);
    expect(killProcessTree).toHaveBeenCalledExactlyOnceWith({
      pid: 123, child: undefined, reason: 'manual',
    });
    expect(killed).toMatchObject({ outcome: 'success' });
    expect(killed.content).toContain('status: aborted');

    const status = await processTool.execute({ action: 'status', runId }, TEST_TOOL_CONTEXT);
    expect(status.content).toContain('status: aborted');
  });

  it('keeps kill idempotent after a background process completes', async () => {
    const runId = registerProcess({ status: 'completed', endedAt: 2, exitCode: 0 });
    const firstKill = await processTool.execute({ action: 'kill', runId }, TEST_TOOL_CONTEXT);
    const secondKill = await processTool.execute({ action: 'kill', runId }, TEST_TOOL_CONTEXT);

    expect(firstKill).toMatchObject({ outcome: 'success' });
    expect(firstKill.content).toContain('status: completed');
    expect(secondKill).toMatchObject({ outcome: 'success' });
    expect(secondKill.content).toContain('status: completed');
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('returns not found for unknown runId', async () => {
    const result = await processTool.execute({ action: 'status', runId: 'missing' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('runId not found');
  });
});
