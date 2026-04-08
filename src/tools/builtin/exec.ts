import { resolve as resolvePath } from 'node:path';

import type { Tool } from '../types.js';
import type {
  NormalizedExecRequest,
  ProcessRecord,
  TerminalProcessStatus,
} from './exec-types.js';
import { processRegistry } from './process-registry.js';
import { runCommand } from './run-command.js';

const DEFAULT_TIMEOUT_SECONDS = 30;
let runIdCounter = 0;

// exec only accepts string:string env entries so complex objects are never merged into process.env.
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value;
}

function normalizeCwd(value: unknown, defaultCwd: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return defaultCwd;
  }

  return resolvePath(defaultCwd, value);
}

function normalizeEnv(value: unknown): Record<string, string> {
  return isStringRecord(value) ? value : {};
}

function normalizeYieldMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function createRunId(): string {
  runIdCounter += 1;
  return `proc_${Date.now()}_${runIdCounter}`;
}

function buildManagedRecord(
  request: NormalizedExecRequest,
  runId: string,
  visibility: ProcessRecord['visibility'],
): ProcessRecord {
  return {
    runId,
    command: request.command,
    cwd: request.cwd,
    env: request.env,
    status: 'starting',
    visibility,
    createdAt: Date.now(),
    chunks: [],
    output: '',
  };
}

function mapForegroundStatusToToolResult(
  status: TerminalProcessStatus,
  output: string,
  exitCode?: number | null,
  signal?: string | null,
  errorMessage?: string,
) {
  if (status === 'completed') {
    return { content: output };
  }

  const suffix =
    errorMessage
      ? errorMessage
      : status === 'timed_out'
        ? 'Process timed out'
        : status === 'aborted'
        ? `Process aborted${signal ? ` with signal ${signal}` : ''}`
        : `Process exited with code ${exitCode ?? 'unknown'}`;

  return {
    content: `${output}\n\n${suffix}`.trim(),
    isError: true,
  };
}

function normalizeExecRequest(params: Record<string, unknown>, defaultCwd: string):
  | { request: NormalizedExecRequest }
  | { error: string } {
  const command = params.command;
  if (typeof command !== 'string' || !command.trim()) {
    return {
      error: 'Invalid input for tool "exec": "command" must be a non-empty string',
    };
  }

  const background = params.background === true;
  const yieldMs = background ? undefined : normalizeYieldMs(params.yieldMs);
  const cwd = normalizeCwd(params.cwd, defaultCwd);
  const env = normalizeEnv(params.env);
  const timeoutSeconds = normalizeTimeout(params.timeout);

  if (params.timeout !== undefined && timeoutSeconds === 0) {
    return {
      error: 'Invalid input for tool "exec": "timeout" must be a positive number',
    };
  }

  if (params.yieldMs !== undefined && !background && yieldMs === undefined) {
    return {
      error: 'Invalid input for tool "exec": "yieldMs" must be a positive number',
    };
  }

  return {
    request: {
      command: command.trim(),
      cwd,
      env,
      timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : background || yieldMs ? undefined : DEFAULT_TIMEOUT_SECONDS * 1000,
      mode: background ? 'background' : yieldMs ? 'yield' : 'foreground',
      yieldMs,
    },
  };
}

function startManagedCommand(request: NormalizedExecRequest, runId: string, visibility: ProcessRecord['visibility'], signal?: AbortSignal) {
  processRegistry.create(buildManagedRecord(request, runId, visibility));

  let childRef: ReturnType<typeof runCommand>['child'] | undefined;
  const running = runCommand({
    command: request.command,
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    detached: process.platform !== 'win32',
    signal,
    onStdout: (chunk) => {
      processRegistry.appendOutput(runId, chunk);
    },
    onStderr: (chunk) => {
      processRegistry.appendOutput(runId, chunk);
    },
    onSpawn: (pid) => {
      processRegistry.markRunning(runId, {
        pid,
        startedAt: Date.now(),
        child: childRef,
      });
    },
    onExit: (result) => {
      processRegistry.complete(runId, {
        status: result.status,
        endedAt: Date.now(),
        exitCode: result.exitCode,
        signal: result.signal,
        errorMessage: result.errorMessage,
      });
    },
  });

  childRef = running.child;

  return running;
}

function formatBackgroundStarted(runId: string, yielded: boolean): string {
  return yielded
    ? `Process is still running.\nrunId: ${runId}\nUse the process tool to check status, read logs, or kill it.`
    : `Process started in background.\nrunId: ${runId}\nUse the process tool to check status, read logs, or kill it.`;
}

export const execTool: Tool = {
  name: 'exec',
  description: 'Execute a shell command. Supports foreground execution, yield continuation with yieldMs, and immediate background execution with background=true.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command. Defaults to the current process directory.',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables to pass to the command.',
        additionalProperties: { type: 'string' },
      },
      yieldMs: {
        type: 'number',
        description: 'Run in foreground briefly, then switch to background if still running.',
      },
      background: {
        type: 'boolean',
        description: 'Start in background immediately and return a runId.',
      },
    },
    required: ['command'],
  },
  execute: async (params, context) => {
    const normalized = normalizeExecRequest(params, process.cwd());
    if ('error' in normalized) {
      return {
        content: normalized.error,
        isError: true,
      };
    }

    const { request } = normalized;

    if (request.mode === 'foreground') {
      // The pure foreground path bypasses the registry and behaves like a synchronous command run.
      const running = runCommand({
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        signal: context?.signal,
      });
      const outcome = await running.completion;
      return mapForegroundStatusToToolResult(
        outcome.status,
        outcome.output,
        outcome.exitCode,
        outcome.signal,
        outcome.errorMessage,
      );
    }

    const runId = createRunId();
    const visibility = request.mode === 'background' ? 'background' : 'internal';
    const running = startManagedCommand(request, runId, visibility, context?.signal);

    try {
      await running.started;
    } catch (error) {
      processRegistry.delete(runId);
      return {
        content: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    if (request.mode === 'background') {
      return {
        content: formatBackgroundStarted(runId, false),
      };
    }

    // The yield path races command completion against the yield deadline to decide whether to hand off to process management.
    const race = await Promise.race([
      running.completion.then((outcome) => ({ type: 'completed' as const, outcome })),
      new Promise<{ type: 'yield' }>((resolve) => {
        setTimeout(() => resolve({ type: 'yield' }), request.yieldMs);
      }),
    ]);

    if (race.type === 'completed') {
      processRegistry.delete(runId);
      return mapForegroundStatusToToolResult(
        race.outcome.status,
        race.outcome.output,
        race.outcome.exitCode,
        race.outcome.signal,
        race.outcome.errorMessage,
      );
    }

    const record = processRegistry.get(runId);
    if (!record || (record.status !== 'starting' && record.status !== 'running')) {
      // The process may have finished just as the yield deadline was reached; in that case, fall back to a foreground result.
      const outcome = await running.completion;
      processRegistry.delete(runId);
      return mapForegroundStatusToToolResult(
        outcome.status,
        outcome.output,
        outcome.exitCode,
        outcome.signal,
        outcome.errorMessage,
      );
    }

    // Only still-running tasks are promoted from an internal record to a background-visible record.
    processRegistry.exposeToBackground(runId, {
      exposedAt: Date.now(),
      yielded: true,
    });

    return {
      content: formatBackgroundStarted(runId, true),
    };
  },
};