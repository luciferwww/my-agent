import { spawn } from 'node:child_process';

import type { ChildProcess } from 'node:child_process';

export interface KillProcessTreeOptions {
  pid?: number;
  child?: Pick<ChildProcess, 'kill'>;
  reason: 'manual' | 'timeout' | 'abort';
  graceMs?: number;
}

export interface KillProcessTreeResult {
  ok: boolean;
  attemptedForce: boolean;
  method: 'windows-taskkill' | 'unix-process-group' | 'unix-single-pid' | 'child-kill' | 'none';
}

export interface KillProcessTreeRuntime {
  isProcessAlive?: (pid: number) => boolean;
  signalSingleProcess?: (pid: number, signal: NodeJS.Signals) => boolean;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
  runTaskkill?: (args: string[]) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GRACE_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }

    return true;
  }
}

function signalSingleProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }

    if (isPermissionError(error)) {
      return false;
    }

    return false;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }

    if (isPermissionError(error)) {
      return false;
    }

    return false;
  }
}

function runTaskkill(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // taskkill is the most reliable way to stop a whole process tree on Windows.
    const taskkill = spawn('taskkill', args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });

    taskkill.once('error', () => resolve(false));
    taskkill.once('close', (code) => resolve(code === 0));
  });
}

export async function killProcessTreeWindows(
  pid: number,
  graceMs: number,
  runtime: KillProcessTreeRuntime = {},
): Promise<KillProcessTreeResult> {
  const isAlive = runtime.isProcessAlive ?? isProcessAlive;
  const taskkill = runtime.runTaskkill ?? runTaskkill;
  const pause = runtime.sleep ?? sleep;

  if (!isAlive(pid)) {
    return {
      ok: true,
      attemptedForce: false,
      method: 'windows-taskkill',
    };
  }

  await taskkill(['/T', '/PID', String(pid)]);
  if (!isAlive(pid)) {
    return {
      ok: true,
      attemptedForce: false,
      method: 'windows-taskkill',
    };
  }

  // Give the tree a brief grace period before escalating to /F.
  await pause(graceMs);
  if (!isAlive(pid)) {
    return {
      ok: true,
      attemptedForce: false,
      method: 'windows-taskkill',
    };
  }

  await taskkill(['/F', '/T', '/PID', String(pid)]);
  return {
    ok: !isAlive(pid),
    attemptedForce: true,
    method: 'windows-taskkill',
  };
}

export async function killProcessTreeUnix(
  pid: number,
  graceMs: number,
  runtime: KillProcessTreeRuntime = {},
): Promise<KillProcessTreeResult> {
  const isAlive = runtime.isProcessAlive ?? isProcessAlive;
  const signalGroup = runtime.signalProcessGroup ?? signalProcessGroup;
  const signalSingle = runtime.signalSingleProcess ?? signalSingleProcess;
  const pause = runtime.sleep ?? sleep;

  // On Unix we prefer process-group signals so background tasks do not leave children behind.
  const usedProcessGroup = signalGroup(pid, 'SIGTERM');
  if (!usedProcessGroup) {
    signalSingle(pid, 'SIGTERM');
  }

  if (!isAlive(pid)) {
    return {
      ok: true,
      attemptedForce: false,
      method: usedProcessGroup ? 'unix-process-group' : 'unix-single-pid',
    };
  }

  // Fall back to SIGKILL only after the grace window expires.
  await pause(graceMs);
  if (!isAlive(pid)) {
    return {
      ok: true,
      attemptedForce: false,
      method: usedProcessGroup ? 'unix-process-group' : 'unix-single-pid',
    };
  }

  if (usedProcessGroup) {
    signalGroup(pid, 'SIGKILL');
  } else {
    signalSingle(pid, 'SIGKILL');
  }

  return {
    ok: !isAlive(pid),
    attemptedForce: true,
    method: usedProcessGroup ? 'unix-process-group' : 'unix-single-pid',
  };
}

export async function killProcessTree(options: KillProcessTreeOptions): Promise<KillProcessTreeResult> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  if (options.pid) {
    if (process.platform === 'win32') {
      return killProcessTreeWindows(options.pid, graceMs);
    }

    return killProcessTreeUnix(options.pid, graceMs);
  }

  if (options.child) {
    // This fallback keeps foreground or pre-spawn edge cases from failing outright when no pid is available yet.
    return {
      ok: options.child.kill(),
      attemptedForce: false,
      method: 'child-kill',
    };
  }

  return {
    ok: false,
    attemptedForce: false,
    method: 'none',
  };
}