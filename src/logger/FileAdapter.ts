import { appendFile, mkdir } from 'node:fs/promises';
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
  private flushing = false;
  private closed = false;
  private flushPromise: Promise<void> | null = null;

  onError?: (err: Error, entry: LogEntry) => void;

  constructor(config: FileAdapterConfig) {
    this.dir = config.dir;
    this.prefix = config.prefix ?? 'app';
    this.minLevel = config.minLevel;
    this.maxQueueSize = config.maxQueueSize ?? 10_000;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  write(entry: LogEntry): void {
    if (this.closed) return;
    if (this.minLevel !== undefined && LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.onError?.(new Error('FileAdapter queue full, dropping entry'), entry);
      return;
    }
    this.queue.push(entry);
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    this.closed = true;
    // 等当前 flush 完成，再 flush 剩余
    if (this.flushPromise) await this.flushPromise;
    if (this.queue.length > 0) await this.flush();
  }

  // ── 内部 ─────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flushing = true;
    this.flushPromise = Promise.resolve().then(() => this.flush());
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      const byDate = new Map<string, LogEntry[]>();

      for (const entry of batch) {
        const date = entry.timestamp.toISOString().slice(0, 10); // YYYY-MM-DD
        const list = byDate.get(date) ?? [];
        list.push(entry);
        byDate.set(date, list);
      }

      for (const [date, entries] of byDate) {
        const filePath = join(this.dir, `${this.prefix}.${date}.log`);
        const lines = entries.map((e) => JSON.stringify({
          level: e.level,
          module: e.module,
          message: e.message,
          timestamp: e.timestamp.toISOString(),
          ...(e.context !== undefined ? { context: e.context } : {}),
        })).join('\n') + '\n';

        try {
          await appendFile(filePath, lines, 'utf-8');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const entry of entries) {
            this.onError?.(error, entry);
          }
        }
      }
    }
    this.flushing = false;
    this.flushPromise = null;
  }
}
