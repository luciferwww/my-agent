import type { OutputChunk, ProcessRecord, ProcessStatus } from './exec-types.js';

export interface ProcessRegistry {
  create(record: ProcessRecord): void;
  get(runId: string, sessionId: string): ProcessRecord | undefined;
  listVisible(sessionId: string): ProcessRecord[];
  delete(runId: string): void;
  setControl(runId: string, control: NonNullable<ProcessRecord['control']>): void;
  markRunning(runId: string, update: { pid: number; startedAt: number }): void;
  terminate(runId: string, sessionId: string, reason: 'manual' | 'timeout' | 'abort'): Promise<void>;
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
      (candidate) => candidate.kind !== 'foreground'
        && (!TERMINAL_STATUSES.has(candidate.status) || candidate.control?.released === false),
    ).length;
    if (record.kind !== 'foreground' && activeCount >= MAX_ACTIVE_MANAGED_PROCESSES) {
      throw new ProcessRegistryCapacityError();
    }
    this.records.set(record.runId, { ...record, chunks: [...record.chunks] });
  }

  get(runId: string, sessionId: string): ProcessRecord | undefined {
    const record = this.records.get(runId);
    if (!record || record.sessionId !== sessionId || record.kind === 'foreground') {
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
        record.kind !== 'foreground' && record.sessionId === sessionId && record.visibility === 'background'
      ))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({
        ...record,
        chunks: [...record.chunks],
      }));
  }

  delete(runId: string): void {
    if (this.records.get(runId)?.control?.released === false) return;
    this.records.delete(runId);
  }

  setControl(runId: string, control: NonNullable<ProcessRecord['control']>): void {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Unknown process owner: ${runId}`);
    record.control = control;
  }

  markRunning(runId: string, update: { pid: number; startedAt: number }): void {
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
  }

  exposeToBackground(runId: string, update: { exposedAt: number; yielded: boolean }): void {
    const record = this.records.get(runId);
    if (!record) {
      return;
    }

    if (TERMINAL_STATUSES.has(record.status) && update.yielded) {
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
    if (record.control?.released) record.control = undefined;
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
    if (record.control?.released) record.control = undefined;
    this.evictOldTerminalRecords();
  }

  reset(): void {
    for (const [id, record] of this.records) {
      if (record.control?.released === false) {
        void record.control.terminate('abort').then(() => {
          if (this.records.get(id) === record && record.control?.released) this.records.delete(id);
        }, () => {
          process.stderr.write(`[Process] Cleanup remains unconfirmed for ${id}\n`);
        });
      } else this.records.delete(id);
    }
  }

  async terminate(runId: string, sessionId: string, reason: 'manual' | 'timeout' | 'abort'): Promise<void> {
    const record = this.records.get(runId);
    if (!record || record.sessionId !== sessionId) throw new Error(`Unknown process owner: ${runId}`);
    if (!record.control) {
      if (TERMINAL_STATUSES.has(record.status)) return;
      throw new Error(`Process control is unavailable: ${runId}`);
    }
    const control = record.control;
    if (!control.released) await control.terminate(reason);
    if (!control.released) throw new Error(`Process cleanup remains unconfirmed: ${runId}`);
    if (record.control === control) record.control = undefined;
    this.evictOldTerminalRecords();
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const owned = [...this.records.values()].filter(
      (record) => record.sessionId === sessionId,
    );
    const failures: string[] = [];
    await Promise.all(owned.map(async (record) => {
      if (record.control?.released === false || !TERMINAL_STATUSES.has(record.status)) {
        try {
          await this.terminate(record.runId, sessionId, 'abort');
        } catch {
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
      .filter((record) => record.kind !== 'foreground' && TERMINAL_STATUSES.has(record.status)
        && record.control?.released !== false)
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