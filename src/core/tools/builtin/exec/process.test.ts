import { afterEach, describe, expect, it } from 'vitest';

import { execTool } from './exec.js';
import { processTool } from './process.js';
import { processRegistry } from './process-registry.js';
import { TEST_TOOL_CONTEXT } from '../../test-utils.js';

function extractRunId(content: string): string {
  const match = content.match(/runId:\s*(\S+)/);
  if (!match) {
    throw new Error(`runId not found in content: ${content}`);
  }

  return match[1]!;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  processRegistry.reset();
});

describe('processTool', () => {
  it('lists visible background processes', async () => {
    const started = await execTool.execute({
      command: 'node -e "setTimeout(() => console.log(\'background\'), 150)"',
      background: true,
    }, TEST_TOOL_CONTEXT);

    const runId = extractRunId(started.content);
    const list = await processTool.execute({ action: 'list' }, TEST_TOOL_CONTEXT);
    expect(list.content).toContain(runId);
  });

  it('returns logs for a background process', async () => {
    const started = await execTool.execute({
      command: 'node -e "setTimeout(() => console.log(\'background-log\'), 50)"',
      background: true,
    }, TEST_TOOL_CONTEXT);

    const runId = extractRunId(started.content);
    await waitFor(async () => {
      const logs = await processTool.execute({ action: 'log', runId }, TEST_TOOL_CONTEXT);
      return logs.content.includes('background-log');
    });

    const logs = await processTool.execute({ action: 'log', runId }, TEST_TOOL_CONTEXT);
    expect(logs.content).toContain('background-log');
  });

  it('kills a running background process', async () => {
    const started = await execTool.execute({
      command: 'node -e "setInterval(() => console.log(\'tick\'), 50)"',
      background: true,
    }, TEST_TOOL_CONTEXT);

    const runId = extractRunId(started.content);
    const killed = await processTool.execute({ action: 'kill', runId }, TEST_TOOL_CONTEXT);
    expect(killed.content).toContain('status: aborted');

    const status = await processTool.execute({ action: 'status', runId }, TEST_TOOL_CONTEXT);
    expect(status.content).toContain('status: aborted');
  });

  it('returns not found for unknown runId', async () => {
    const result = await processTool.execute({ action: 'status', runId: 'missing' }, TEST_TOOL_CONTEXT);
    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('runId not found');
  });
});