import { describe, expect, it } from 'vitest';

import { execTool } from './exec.js';

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
});