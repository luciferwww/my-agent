import { appendFile, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogAdapter, LogEntry, LogLevel } from './types.js';

export interface FileAdapterConfig {
  /** 日志文件目录 */
  dir: string;
  /** 文件名前缀；默认 'app' → app.2026-04-24.log */
  prefix?: string;
  /** 此 adapter 的最低输出级别；不设则跟随 Logger 全局 minLevel */
  minLevel?: LogLevel;
  /** 内部队列上限，超出后丢弃并触发 onError；默认 10_000 */
  maxQueueSize?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class FileAdapter implements LogAdapter {
  private readonly dir: string;
  private readonly prefix: string;
  private readonly minLevel: LogLevel | undefined;
  private readonly maxQueueSize: number;

  private queue: LogEntry[] = [];
  private closed = false;
  private flushPromise: Promise<void> | null = null;
  private cleanupDate = '';
  private failures = new Set<string>();
  private writeFailure: Error | undefined;

  onError?: (err: Error, entry: LogEntry) => void;

  constructor(config: FileAdapterConfig) {
    this.dir = config.dir;
    this.prefix = config.prefix ?? 'app';
    this.minLevel = config.minLevel;
    this.maxQueueSize = config.maxQueueSize ?? 10_000;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = await open(join(this.dir, `${this.prefix}.${utcDate()}.log`), 'a');
    try {
      if (!(await file.stat()).isFile()) throw new Error('File log destination is not a regular file.');
    } finally {
      await file.close();
    }
    await this.cleanup();
  }

  write(entry: LogEntry): void {
    if (this.closed) return;
    if (this.minLevel !== undefined && LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.reportFailure('queue-overflow', new Error('File log queue overflow'), entry);
      return;
    }
    this.queue.push(entry);
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.flushPromise) await this.flushPromise;
    if (this.writeFailure) throw this.writeFailure;
  }

  // ── 内部 ─────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushPromise) return;
    this.flushPromise = Promise.resolve().then(() => this.flush()).finally(() => {
      this.flushPromise = null;
      if (this.queue.length > 0) this.scheduleFlush();
    });
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      this.failures.delete('queue-overflow');
      if (utcDate() > this.cleanupDate) await this.cleanup();
      const byDate = new Map<string, LogEntry[]>();

      for (const entry of batch) {
        const date = entry.timestamp.toISOString().slice(0, 10); // YYYY-MM-DD
        const list = byDate.get(date) ?? [];
        list.push(entry);
        byDate.set(date, list);
      }

      for (const [date, entries] of byDate) {
        const filePath = join(this.dir, `${this.prefix}.${date}.log`);
        try {
          const lines = entries.map((e) => JSON.stringify({
            level: e.level,
            module: e.module,
            message: e.message,
            timestamp: e.timestamp.toISOString(),
            ...(e.context !== undefined ? { context: e.context } : {}),
          })).join('\n') + '\n';
          await appendFile(filePath, lines, 'utf-8');
          this.failures.delete('append');
        } catch (err) {
          this.reportFailure('append', err, entries[0]);
        }
      }
    }
  }

  private async cleanup(): Promise<void> {
    const today = utcDate();
    this.cleanupDate = today;
    const cutoff = new Date(`${today}T00:00:00.000Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - 6);
    const oldest = cutoff.toISOString().slice(0, 10);
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(`${this.prefix}.`)) continue;
        const date = entry.name.slice(this.prefix.length + 1, -4);
        if (
          !entry.name.endsWith('.log')
          || !/^\d{4}-\d{2}-\d{2}$/.test(date)
          || !isValidDate(date)
          || date >= oldest
        ) continue;
        await unlink(join(this.dir, entry.name));
      }
      this.failures.delete('cleanup');
    } catch (error) {
      this.reportFailure('cleanup', error);
    }
  }

  private reportFailure(operation: string, error: unknown, entry?: LogEntry): void {
    const code = error instanceof Error && 'code' in error
      && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? ` (${error.code})` : '';
    const diagnostic = new Error(`File logging ${operation} failed${code}.`);
    if (operation !== 'cleanup') this.writeFailure ??= diagnostic;
    if (this.failures.has(operation)) return;
    this.failures.add(operation);
    process.stderr.write(`[Logger] ${diagnostic.message}\n`);
    if (entry && this.onError) {
      try {
        this.onError(diagnostic, entry);
      } catch {
        process.stderr.write('[Logger] File error callback failed.\n');
      }
    }
  }
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
