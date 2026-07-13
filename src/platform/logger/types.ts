export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志条目，所有 adapter 接收统一结构 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  module: string;
  timestamp: Date;
  context?: Record<string, unknown>;
}

/**
 * 日志 adapter 接口。
 * write() 同步 fire-and-forget；adapter 内部按需实现异步队列。
 * lifecycle 由 adapter 自己管理，Logger 在 configure/close 时编排。
 */
export interface LogAdapter {
  write(entry: LogEntry): void;
  start?(): Promise<void>;
  close?(): Promise<void>;
  onError?: (err: Error, entry: LogEntry) => void;
}

export interface LoggerConfig {
  adapters: LogAdapter[];
  /** 全局最低输出级别，低于此级别的 entry 不传给任何 adapter；默认 'info' */
  minLevel?: LogLevel;
}
