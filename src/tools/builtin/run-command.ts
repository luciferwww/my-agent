import { spawn } from 'node:child_process';

import type { RunningCommand, RunCommandOptions, TerminalProcessStatus } from './exec-types.js';

function mapExitStatus(code: number | null, signal: NodeJS.Signals | null, timedOut: boolean): TerminalProcessStatus {
  if (timedOut) {
    return 'timed_out';
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
  const child = spawn(options.command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: true,
    signal: options.signal,
  });

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
  let timedOut = false;
  let settled = false;

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
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : undefined;

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

    child.on('close', (code, signal) => {
      // Different platforms may trigger both error and close; settled ensures completion resolves only once.
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }

      const status = mapExitStatus(code, signal, timedOut);
      const output = chunks
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((chunk) => chunk.text)
        .join('');

      const result = {
        mode: 'foreground' as const,
        status,
        output,
        exitCode: code,
        signal,
        errorMessage:
          status === 'timed_out' && options.timeoutMs
            ? `Process timed out after ${options.timeoutMs / 1000} seconds`
            : undefined,
      };

      options.onExit?.({
        status,
        exitCode: code,
        signal,
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