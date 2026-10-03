import { describe, expect, it, vi } from 'vitest';

import { killProcessTreeUnix, killProcessTreeWindows } from './kill-process-tree.js';

describe('killProcessTreeWindows', () => {
  it('escalates from /T to /F /T when the process stays alive', async () => {
    const runTaskkill = vi.fn().mockResolvedValue(true);
    const isProcessAlive = vi
      .fn<(_pid: number) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await killProcessTreeWindows(123, 0, {
      isProcessAlive,
      runTaskkill,
      sleep: async () => {},
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(1, ['/T', '/PID', '123']);
    expect(runTaskkill).toHaveBeenNthCalledWith(2, ['/F', '/T', '/PID', '123']);
    expect(result).toEqual({
      ok: true,
      attemptedForce: true,
      method: 'windows-taskkill',
    });
  });
});

describe('killProcessTreeUnix', () => {
  it('prefers process-group signals before forcing kill', async () => {
    const signalProcessGroup = vi.fn().mockReturnValue(true);
    const signalSingleProcess = vi.fn().mockReturnValue(false);
    const isProcessAlive = vi
      .fn<(_pid: number) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await killProcessTreeUnix(456, 0, {
      isProcessAlive,
      signalProcessGroup,
      signalSingleProcess,
      sleep: async () => {},
    });

    expect(signalProcessGroup).toHaveBeenNthCalledWith(1, 456, 'SIGTERM');
    expect(signalProcessGroup).toHaveBeenNthCalledWith(2, 456, 'SIGKILL');
    expect(signalSingleProcess).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      attemptedForce: true,
      method: 'unix-process-group',
    });
  });
});