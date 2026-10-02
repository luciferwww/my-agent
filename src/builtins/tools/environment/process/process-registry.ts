import type { OutputChunk, ProcessRecord, ProcessStatus } from './exec-types.js';
import { killProcessTree } from './kill-process-tree.js';

export interface ProcessRegistry {
  create(record: ProcessRecord): void;
  get(runId: string, sessionId: string): ProcessRecord | undefined;
  listVisible(sessionId: string): ProcessRecord[];
  delete(runId: string): void;
  setChild(runId: string, child: NonNullable<ProcessRecord['child']>): void;
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
  cleanupSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
  reset(): void;
}

const TERMINAL_STATUSES = new Set<ProcessStatus>(['completed', 'failed', 'timed_out', 'aborted']);
export const MAX_ACTIVE_MANAGED_PROCESSES = 8;
export const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
export const MAX_RETAINED_TERMINAL_PROCESSES = 32;
const OUTPUT_TRUNCATION_MARKER = '[Earlier process output truncated]\n';

export class ProcessRegistryCapacityError extends Error {
  constructor() {
    super(`Managed process capacity is full (${MAX_ACTIVE_MANAGED_PROCESSES}).`);
    this.name = 'ProcessRegistryCapacityError';
  }
}

export class InMemoryProcessRegistry implements ProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>();

  create(record: ProcessRecord): void {
    const activeCount = [...this.records.values()].filter(
      (candidate) => !TERMINAL_STATUSES.has(candidate.status),
    ).length;
    if (activeCount >= MAX_ACTIVE_MANAGED_PROCESSES) {
      throw new ProcessRegistryCapacityError();
    }
    this.records.set(record.runId, { ...record, chunks: [...record.chunks] });
  }

  get(runId: string, sessionId: string): ProcessRecord | undefined {
    const record = this.records.get(runId);
    if (!record || record.sessionId !== sessionId) {
      return undefined;
    }

    return {
      ...record,
      chunks: [...record.chunks],
    };
  }

  listVisible(sessionId: string): ProcessRecord[] {
    return Array.from(this.records.values())
      .filter((record) => (
        record.sessionId === sessionId && record.visibility === 'background'
      ))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({
        ...record,
        chunks: [...record.chunks],
      }));
  }

  delete(runId: string): void {
    this.records.delete(runId);
  }

  setChild(runId: string, child: NonNullable<ProcessRecord['child']>): void {
    const record = this.records.get(runId);
    if (!record || TERMINAL_STATUSES.has(record.status)) return;
    record.child = child;
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
    if (Buffer.byteLength(record.output, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
      const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, 'utf8');
      const retained = Buffer.from(record.output, 'utf8')
        .subarray(-(MAX_PROCESS_OUTPUT_BYTES - markerBytes))
        .toString('utf8')
        .replace(/^\uFFFD+/, '');
      record.output = OUTPUT_TRUNCATION_MARKER + retained;
      record.outputTruncated = true;
      record.chunks = [{
        ...chunk,
        text: record.output,
      }];
    }
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
    this.evictOldTerminalRecords();
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
    this.evictOldTerminalRecords();
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

  async cleanupSession(sessionId: string): Promise<void> {
    const owned = [...this.records.values()].filter(
      (record) => record.sessionId === sessionId,
    );
    const failures: string[] = [];
    await Promise.all(owned.map(async (record) => {
      if (!TERMINAL_STATUSES.has(record.status) && (record.child || record.pid)) {
        const result = await killProcessTree({
          pid: record.pid,
          child: record.child,
          reason: 'abort',
        });
        if (!result.ok && (record.child || record.pid)) {
          failures.push(record.runId);
          return;
        }
      }
      this.records.delete(record.runId);
    }));
    if (failures.length > 0) {
      throw new Error(`Failed to clean up managed processes: ${failures.join(', ')}.`);
    }
  }

  async shutdown(): Promise<void> {
    const sessionIds = [...new Set(
      [...this.records.values()].map((record) => record.sessionId),
    )];
    const outcomes = await Promise.allSettled(
      sessionIds.map((sessionId) => this.cleanupSession(sessionId)),
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Managed process shutdown did not converge.',
      );
    }
  }

  private evictOldTerminalRecords(): void {
    const terminal = [...this.records.values()]
      .filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort((left, right) => (
        (left.endedAt ?? left.createdAt) - (right.endedAt ?? right.createdAt)
        || left.createdAt - right.createdAt
      ));
    for (const record of terminal.slice(0, -MAX_RETAINED_TERMINAL_PROCESSES)) {
      this.records.delete(record.runId);
    }
  }
}

export const processRegistry = new InMemoryProcessRegistry();