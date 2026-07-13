import type { OutputChunk, ProcessRecord, ProcessStatus } from './exec-types.js';
import { killProcessTree } from './kill-process-tree.js';

export interface ProcessRegistry {
  create(record: ProcessRecord): void;
  get(runId: string): ProcessRecord | undefined;
  listVisible(): ProcessRecord[];
  delete(runId: string): void;
  markRunning(runId: string, update: { pid: number; startedAt: number; child?: ProcessRecord['child'] }): void;
  exposeToBackground(runId: string, update: { exposedAt: number; yielded: boolean }): void;
  appendOutput(runId: string, chunk: OutputChunk): void;
  complete(
    runId: string,
    update: {
      status: Exclude<ProcessStatus, 'starting' | 'running'>;
      endedAt: number;
      exitCode?: number | null;
      signal?: string | null;
      errorMessage?: string;
    },
  ): void;
  forceComplete(
    runId: string,
    update: {
      status: Exclude<ProcessStatus, 'starting' | 'running'>;
      endedAt: number;
      exitCode?: number | null;
      signal?: string | null;
      errorMessage?: string;
    },
  ): void;
  reset(): void;
}

const TERMINAL_STATUSES = new Set<ProcessStatus>(['completed', 'failed', 'timed_out', 'aborted']);

export class InMemoryProcessRegistry implements ProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>();

  create(record: ProcessRecord): void {
    this.records.set(record.runId, { ...record, chunks: [...record.chunks] });
  }

  get(runId: string): ProcessRecord | undefined {
    const record = this.records.get(runId);
    if (!record) {
      return undefined;
    }

    return {
      ...record,
      chunks: [...record.chunks],
    };
  }

  listVisible(): ProcessRecord[] {
    return Array.from(this.records.values())
      .filter((record) => record.visibility === 'background')
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({
        ...record,
        chunks: [...record.chunks],
      }));
  }

  delete(runId: string): void {
    this.records.delete(runId);
  }

  markRunning(runId: string, update: { pid: number; startedAt: number; child?: ProcessRecord['child'] }): void {
    const record = this.records.get(runId);
    if (!record) {
      return;
    }

    if (TERMINAL_STATUSES.has(record.status)) {
      return;
    }

    record.status = 'running';
    record.pid = update.pid;
    record.startedAt = update.startedAt;
    record.child = update.child;
  }

  exposeToBackground(runId: string, update: { exposedAt: number; yielded: boolean }): void {
    const record = this.records.get(runId);
    if (!record) {
      return;
    }

    if (TERMINAL_STATUSES.has(record.status)) {
      return;
    }

    record.visibility = 'background';
    record.exposedAt = update.exposedAt;
    record.yielded = update.yielded;
  }

  appendOutput(runId: string, chunk: OutputChunk): void {
    const record = this.records.get(runId);
    if (!record) {
      return;
    }

    record.chunks.push(chunk);
    record.output += chunk.text;
  }

  complete(
    runId: string,
    update: {
      status: Exclude<ProcessStatus, 'starting' | 'running'>;
      endedAt: number;
      exitCode?: number | null;
      signal?: string | null;
      errorMessage?: string;
    },
  ): void {
    const record = this.records.get(runId);
    if (!record) {
      return;
    }

    if (TERMINAL_STATUSES.has(record.status)) {
      return;
    }

    record.status = update.status;
    record.endedAt = update.endedAt;
    record.exitCode = update.exitCode;
    record.signal = update.signal;
    record.errorMessage = update.errorMessage;
    record.child = undefined;
  }

  forceComplete(
    runId: string,
    update: {
      status: Exclude<ProcessStatus, 'starting' | 'running'>;
      endedAt: number;
      exitCode?: number | null;
      signal?: string | null;
      errorMessage?: string;
    },
  ): void {
    const record = this.records.get(runId);
    if (!record) {
      return;
    }

    // Manual kill may race with the child closing on its own, so this path intentionally overwrites an earlier terminal state.
    record.status = update.status;
    record.endedAt = update.endedAt;
    record.exitCode = update.exitCode;
    record.signal = update.signal;
    record.errorMessage = update.errorMessage;
    record.child = undefined;
  }

  reset(): void {
    for (const record of this.records.values()) {
      if ((record.child || record.pid) && !TERMINAL_STATUSES.has(record.status)) {
        // reset is best-effort cleanup for tests and process teardown, so failures are intentionally ignored here.
        void killProcessTree({
          pid: record.pid,
          child: record.child,
          reason: 'abort',
          graceMs: 0,
        });
      }
    }

    this.records.clear();
  }
}

export const processRegistry = new InMemoryProcessRegistry();