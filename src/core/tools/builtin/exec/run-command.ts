import { spawn } from 'node:child_process';

import type { RunningCommand, RunCommandOptions, TerminalProcessStatus } from './exec-types.js';
import { killProcessTree } from './kill-process-tree.js';
import { resolveCommandInvocation } from './resolve-command-invocation.js';

const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 100;
const WINDOWS_CLOSE_STATE_POLL_MS = 10;

export interface SettleWindowsExitStateOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  pollMs?: number;
}

export async function settleWindowsExitState(
  child: Pick<ReturnType<typeof spawn>, 'exitCode' | 'signalCode'>,
  code: number | null,
  signal: NodeJS.Signals | null,
  options: SettleWindowsExitStateOptions = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? WINDOWS_CLOSE_STATE_POLL_MS;

  if (platform !== 'win32' || code !== null || signal !== null) {
    return { code, signal };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const settledCode = child.exitCode;
    const settledSignal = child.signalCode;
    if (settledCode !== null || settledSignal !== null) {
      return {
        code: settledCode,
        signal: settledSignal,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return {
    code: child.exitCode,
    signal: child.signalCode,
  };
}

function mapExitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
  terminationState?: 'timed_out' | 'aborted',
): TerminalProcessStatus {
  if (terminationState === 'timed_out') {
    return 'timed_out';
  }

  if (terminationState === 'aborted') {
    return 'aborted';
  }

  if (signal) {
    return 'aborted';
  }

  if (code === 0) {
    return 'completed';
  }

  return 'failed';
}

export function runCommand(options: RunCommandOptions): RunningCommand {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );

  const invocation = resolveCommandInvocation({
    command: options.command,
    cwd: options.cwd,
    env,
    detached: options.detached,
    signal: options.signal,
  });

  const child = spawn(invocation.file, invocation.args, invocation.options);

  let startedSettled = false;
  let resolveStarted!: (pid: number) => void;
  let rejectStarted!: (error: Error) => void;

  // started separates a successful spawn from eventual process completion; the background path waits for this before returning a runId.
  const started = new Promise<number>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  child.once('spawn', () => {
    const pid = child.pid;
    if (!pid || startedSettled) {
      return;
    }

    startedSettled = true;
    options.onSpawn?.(pid);
    resolveStarted(pid);
  });

  if (child.pid) {
    queueMicrotask(() => {
      if (startedSettled || !child.pid) {
        return;
      }

      startedSettled = true;
      options.onSpawn?.(child.pid);
      resolveStarted(child.pid);
    });
  }

  const chunks: Array<{ timestamp: number; text: string }> = [];
  let terminationState: 'timed_out' | 'aborted' | undefined;
  let settled = false;
  let terminationPromise: Promise<void> | undefined;

  const terminate = (reason: 'timeout' | 'abort') => {
    terminationState = reason === 'timeout' ? 'timed_out' : 'aborted';
    if (terminationPromise) {
      return terminationPromise;
    }

    // timeout, AbortSignal, and manual process cleanup should all reuse the same tree-kill semantics.
    terminationPromise = (async () => {
      await killProcessTree({
        pid: child.pid,
        child,
        reason,
      });
    })();

    return terminationPromise;
  };

  const pushChunk = (stream: 'stdout' | 'stderr', data: Buffer | string) => {
    const chunk = {
      stream,
      text: data.toString(),
      timestamp: Date.now(),
    } as const;

    chunks.push({ timestamp: chunk.timestamp, text: chunk.text });

    if (stream === 'stdout') {
      options.onStdout?.(chunk);
      return;
    }

    options.onStderr?.(chunk);
  };

  child.stdout?.on('data', (data) => pushChunk('stdout', data));
  child.stderr?.on('data', (data) => pushChunk('stderr', data));

  const timer = options.timeoutMs
    ? setTimeout(() => {
        void terminate('timeout');
      }, options.timeoutMs)
    : undefined;

  const abortHandler = () => {
    void terminate('abort');
  };

  if (options.signal) {
    if (options.signal.aborted) {
      // Preserve already-aborted calls so the spawned process is torn down immediately.
      abortHandler();
    } else {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const completion = new Promise<{
    mode: 'foreground';
    status: TerminalProcessStatus;
    output: string;
    exitCode?: number | null;
    signal?: string | null;
    errorMessage?: string;
  }>((resolve) => {
    child.on('error', (error) => {
      if (!startedSettled) {
        startedSettled = true;
        rejectStarted(error);
      }

      if (settled) {
        return;
      }

      settled = true;
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (timer) {
        clearTimeout(timer);
      }

      const result = {
        mode: 'foreground' as const,
        status: 'failed' as const,
        output: chunks
          .sort((left, right) => left.timestamp - right.timestamp)
          .map((chunk) => chunk.text)
          .join(''),
        errorMessage: error.message,
      };

      options.onExit?.({
        status: result.status,
        errorMessage: result.errorMessage,
      });

      resolve(result);
    });

    child.on('close', async (code, signal) => {
      // Different platforms may trigger both error and close; settled ensures completion resolves only once.
      if (settled) {
        return;
      }

      settled = true;
      if (options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (timer) {
        clearTimeout(timer);
      }

      const exitState = await settleWindowsExitState(child, code, signal);
      const status = mapExitStatus(exitState.code, exitState.signal, terminationState);
      const output = chunks
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((chunk) => chunk.text)
        .join('');

      // terminationState wins over the raw exit code so timeout/abort do not get misreported as plain failures.
      const result = {
        mode: 'foreground' as const,
        status,
        output,
        exitCode: exitState.code,
        signal: exitState.signal,
        errorMessage:
          terminationState === 'timed_out' && options.timeoutMs
            ? `Process timed out after ${options.timeoutMs / 1000} seconds`
            : undefined,
      };

      options.onExit?.({
        status,
        exitCode: exitState.code,
        signal: exitState.signal,
        errorMessage: result.errorMessage,
      });

      resolve(result);
    });
  });

  return {
    child,
    started,
    completion,
  };
}