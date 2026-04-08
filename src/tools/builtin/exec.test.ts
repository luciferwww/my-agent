import { afterEach, describe, expect, it } from 'vitest';

import { execTool } from './exec.js';
import { processTool } from './process.js';
import { processRegistry } from './process-registry.js';

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

describe('execTool', () => {
  it('returns stdout for a simple command', async () => {
    const result = await execTool.execute({ command: 'node -e "console.log(\'hello\')"' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hello');
  });

  it('returns an error when the process exits non-zero', async () => {
    const result = await execTool.execute({ command: 'node -e "process.exit(1)"' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Process exited with code 1');
  });

  it('returns timeout errors', async () => {
    const result = await execTool.execute({
      command: 'node -e "setTimeout(() => console.log(\'late\'), 2000)"',
      timeout: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Process timed out after 1 seconds');
  });

  it('runs in a custom cwd', async () => {
    const result = await execTool.execute({
      command: 'node -e "console.log(process.cwd())"',
      cwd: process.cwd(),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(process.cwd());
  });

  it('passes custom environment variables', async () => {
    const result = await execTool.execute({
      command: 'node -e "console.log(process.env.TEST_EXEC_VALUE)"',
      env: { TEST_EXEC_VALUE: 'from-test' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('from-test');
  });

  it('combines stdout and stderr output', async () => {
    const result = await execTool.execute({
      command: 'node -e "console.log(\'out\'); console.error(\'err\')"',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('out');
    expect(result.content).toContain('err');
  });

  it('returns a runId when background=true', async () => {
    const result = await execTool.execute({
      command: 'node -e "setTimeout(() => console.log(\'done\'), 150)"',
      background: true,
    });

    expect(result.isError).toBeUndefined();
    const runId = extractRunId(result.content);
    const status = await processTool.execute({ action: 'status', runId });
    expect(status.content).toContain(`runId: ${runId}`);
  });

  it('yields long-running commands into process management', async () => {
    const result = await execTool.execute({
      command: 'node -e "setTimeout(() => console.log(\'yielded\'), 150)"',
      yieldMs: 25,
    });

    const runId = extractRunId(result.content);
    await waitFor(async () => {
      const status = await processTool.execute({ action: 'status', runId });
      return status.content.includes(`runId: ${runId}`);
    });
  });

  it('does not leak short yield commands into process.list', async () => {
    const result = await execTool.execute({
      command: 'node -e "console.log(\'fast\')"',
      yieldMs: 100,
    });

    expect(result.content).toContain('fast');

    const list = await processTool.execute({ action: 'list' });
    expect(list.content).toBe('No background processes.');
  });
});