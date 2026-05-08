import { ConsoleAdapter } from './ConsoleAdapter.js';
import type { LogAdapter, LogEntry, LoggerConfig, LogLevel } from './types.js';

// ── 级别顺序 ──────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ── LoggerInstance ────────────────────────────────────────

export class LoggerInstance {
  readonly module: string;

  constructor(module: string) {
    this.module = module;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    Logger.write('debug', this.module, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    Logger.write('info', this.module, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    Logger.write('warn', this.module, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    Logger.write('error', this.module, message, context);
  }
}

// ── Logger ────────────────────────────────────────────────

export class Logger {
  // configure() 前使用默认 ConsoleAdapter(minLevel 硬编码 'info')，
  // 避免丢失启动关键信息
  private static adapters: LogAdapter[] = [new ConsoleAdapter({ minLevel: 'info' })];
  private static instances = new Map<string, LoggerInstance>();
  private static minLevel: LogLevel = 'info';

  /**
   * 全局配置，替换当前 adapter 列表并依次调用 start()。
   * 须在应用入口调用一次。重复调用会先 close() 旧 adapter。
   */
  static async configure(config: LoggerConfig): Promise<void> {
    await Logger.closeAdapters(Logger.adapters);
    Logger.adapters = config.adapters;
    Logger.minLevel = config.minLevel ?? 'info';
    for (const adapter of Logger.adapters) {
      await adapter.start?.();
    }
  }

  /**
   * 按模块名获取 LoggerInstance。
   * 相同 name 返回同一实例（内部 Map 缓存）。
   */
  static get(module: string): LoggerInstance {
    let instance = Logger.instances.get(module);
    if (!instance) {
      instance = new LoggerInstance(module);
      Logger.instances.set(module, instance);
    }
    return instance;
  }

  /**
   * 依次调用所有 adapter 的 close()，释放资源。
   * 应在进程退出前调用。
   */
  static async close(): Promise<void> {
    await Logger.closeAdapters(Logger.adapters);
    Logger.adapters = [];
  }

  /** 运行时调整全局最低级别（无需重新 configure）。 */
  static setLevel(level: LogLevel): void {
    Logger.minLevel = level;
  }

  // ── 内部 ─────────────────────────────────────────────────

  static write(level: LogLevel, module: string, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[Logger.minLevel]) return;
    const entry: LogEntry = {
      level,
      message,
      module,
      timestamp: new Date(),
      ...(context !== undefined ? { context } : {}),
    };
    for (const adapter of Logger.adapters) {
      adapter.write(entry);
    }
  }

  private static async closeAdapters(adapters: LogAdapter[]): Promise<void> {
    for (const adapter of adapters) {
      await adapter.close?.();
    }
  }
}
