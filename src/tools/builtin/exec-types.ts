import type { ChildProcess } from 'node:child_process';

export type ProcessStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'aborted';

export type ProcessVisibility = 'internal' | 'background';

export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
  timestamp: number;
}

export interface ProcessRecord {
  runId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  status: ProcessStatus;
  visibility: ProcessVisibility;
  createdAt: number;
  pid?: number;
  startedAt?: number;
  endedAt?: number;
  exposedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  chunks: OutputChunk[];
  output: string;
  errorMessage?: string;
  child?: ChildProcess;
  yielded?: boolean;
}

export interface ExecToolInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  yieldMs?: number;
  background?: boolean;
}

export type ExecMode = 'foreground' | 'yield' | 'background';

export interface NormalizedExecRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  mode: ExecMode;
  yieldMs?: number;
}

export interface ExecToolResultPayload {
  mode: 'foreground' | 'background';
  runId?: string;
  status: 'completed' | 'failed' | 'timed_out' | 'aborted' | 'running';
  output?: string;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  yielded?: boolean;
}

export type ProcessToolInput =
  | {
      action: 'list';
    }
  | {
      action: 'status';
      runId: string;
    }
  | {
      action: 'log';
      runId: string;
      tailLines?: number;
    }
  | {
      action: 'kill';
      runId: string;
    };

export interface ProcessListItem {
  runId: string;
  command: string;
  status: ProcessStatus;
  pid?: number;
  startedAt?: number;
  endedAt?: number;
  yielded?: boolean;
}

export interface ProcessStatusPayload {
  runId: string;
  command: string;
  status: ProcessStatus;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  startedAt?: number;
  endedAt?: number;
  yielded?: boolean;
  summary: string;
}

export interface ProcessLogPayload {
  runId: string;
  status: ProcessStatus;
  output: string;
  tailLines?: number;
}

export type TerminalProcessStatus = Exclude<ProcessStatus, 'starting' | 'running'>;

export type CommandRunOutcome =
  | {
      mode: 'foreground';
      status: TerminalProcessStatus;
      output: string;
      exitCode?: number | null;
      signal?: string | null;
      errorMessage?: string;
    }
  | {
      mode: 'background';
      status: 'running';
      runId: string;
      pid?: number;
      yielded?: boolean;
    };

export interface RunCommandOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: OutputChunk) => void;
  onStderr?: (chunk: OutputChunk) => void;
  onSpawn?: (pid: number) => void;
  onExit?: (result: {
    status: TerminalProcessStatus;
    exitCode?: number | null;
    signal?: string | null;
    errorMessage?: string;
  }) => void;
}

export interface RunningCommand {
  child: ChildProcess;
  started: Promise<number>;
  completion: Promise<Extract<CommandRunOutcome, { mode: 'foreground' }>>;
}