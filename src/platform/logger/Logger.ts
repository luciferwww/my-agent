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

/**
 * 启动期 buffer 上限。Pre-configure 阶段的 entry 先入 head，head 满后入 tail，
 * tail 满后环形挤掉最旧的 tail（dropped 计数）。drain 时按 minLevel 过滤后回放。
 *
 * 数值硬编码（不暴露 config）：
 *   - 启动正常时 < 20 条，HEAD_LIMIT 永远用不满
 *   - 真出现死循环导致溢出时，100 条已足够定位问题，再大也不必
 *   - 暴露给用户调反而增加心智负担，无收益
 */
const STARTUP_BUFFER_HEAD_LIMIT = 20;
const STARTUP_BUFFER_TAIL_LIMIT = 80;

/**
 * Pre-configure 阶段的日志缓冲区结构。
 *
 * 用单个对象 + null 标志位（而非三个独立字段 + 一个 inStartup 布尔），
 * 是为了让"启动期是否结束"只有一个真相来源（startupBuffer === null），
 * 不会出现 head 已清但 dropped 没清的中间不一致态。
 */
interface StartupBuffer {
  /** 前 STARTUP_BUFFER_HEAD_LIMIT 条；溢出后冻结不变，保留启动初期上下文 */
  head: LogEntry[];
  /** 后 STARTUP_BUFFER_TAIL_LIMIT 条；溢出后环形挤掉最旧，保留"出事前最后一帧" */
  tail: LogEntry[];
  /** 中间被环形挤掉的条数；drain 时插入 sentinel 提示读者中间丢了 N 条 */
  dropped: number;
}

export class Logger {
  // ── 正式态字段（首次 configure() 后生效） ──
  //
  // adapters 必须以空数组初始化（不能塞默认 ConsoleAdapter）。
  // 否则启动期会变成"adapter 立即输出 + buffer 也存一份"，
  // configure() drain 时双倍输出，且绕过用户的 console.enabled 配置。
  private static adapters: LogAdapter[] = [];
  private static instances = new Map<string, LoggerInstance>();
  private static minLevel: LogLevel = 'info';

  // ── 启动期 buffer（仅首次 configure() 之前生效） ──
  //
  // 生命周期：
  //   类加载             → startupBuffer = { head: [], tail: [], dropped: 0 }
  //   write() 多次        → 进 head，head 满进 tail，tail 满环形挤掉旧 tail（dropped++）
  //   首次 configure()   → drain（按 minLevel 过滤后派发），随后 startupBuffer = null
  //   再次 configure()   → buf 已为 null，跳过 drain，仅交换 adapters
  //
  // 为什么 head + tail 双段：
  //   - head 保启动初期"why are we here"上下文（workspaceDir、agentId 等）
  //   - tail 保"出事前最后一帧"，调试启动 hang 时最关键
  //   - dropped 让回放插 sentinel 警告"中间丢了 N 条"，避免读者困惑时间戳跳变
  private static startupBuffer: StartupBuffer | null = {
    head: [],
    tail: [],
    dropped: 0,
  };

  /**
   * 全局配置，替换当前 adapter 列表并依次调用 start()。
   *
   * 首次调用时会 drain 启动期 buffer：按本次传入的 minLevel 过滤 buffer 中的 entry，
   * 依次派发到新 adapters；buffer 随后置 null，永久关闭——后续 write() 不再走 buffer 分支。
   *
   * 二次及以上调用：仅交换 adapters / minLevel，不重新启用 buffer。
   */
  static async configure(config: LoggerConfig): Promise<void> {
    await Logger.closeAdapters(Logger.adapters);
    Logger.adapters = config.adapters;
    Logger.minLevel = config.minLevel ?? 'info';
    for (const adapter of Logger.adapters) {
      await adapter.start?.();
    }

    const buf = Logger.startupBuffer;
    Logger.startupBuffer = null;     // 启动期结束的唯一信号
    if (!buf) return;                // 二次 configure：无 buffer 可 drain

    for (const entry of buf.head) Logger.dispatchFiltered(entry);
    if (buf.dropped > 0) {
      Logger.dispatchFiltered({
        level: 'warn',
        module: 'Logger',
        message: `${buf.dropped} log entries dropped during startup buffer overflow`,
        timestamp: new Date(),
      });
    }
    for (const entry of buf.tail) Logger.dispatchFiltered(entry);
  }

  /**
   * 按模块名获取 LoggerInstance。相同 name 返回同一实例（内部 Map 缓存）。
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
   * 依次调用所有 adapter 的 close()，释放资源。应在进程退出前调用。
   *
   * 注意：不会重新启用 startupBuffer——close 后再 write() 静默丢弃，
   * 与"启动期已结束"的契约一致。
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

  /**
   * Pre-configure 阶段不按 minLevel 过滤——此时还不知道用户最终配的 minLevel，
   * 一律入 buffer，drain 时再统一过滤。这样用户配 'debug' 时启动期 debug 日志也能保留。
   */
  static write(level: LogLevel, module: string, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      module,
      timestamp: new Date(),
      ...(context !== undefined ? { context } : {}),
    };

    const buf = Logger.startupBuffer;
    if (buf) {
      if (buf.head.length < STARTUP_BUFFER_HEAD_LIMIT) {
        buf.head.push(entry);
      } else if (buf.tail.length < STARTUP_BUFFER_TAIL_LIMIT) {
        buf.tail.push(entry);
      } else {
        // tail 已满：环形挤掉最旧的 tail entry
        buf.tail.shift();
        buf.tail.push(entry);
        buf.dropped++;
      }
      return;
    }

    // 已 configure 的正常路径
    if (LEVEL_ORDER[level] < LEVEL_ORDER[Logger.minLevel]) return;
    for (const adapter of Logger.adapters) {
      adapter.write(entry);
    }
  }

  private static dispatchFiltered(entry: LogEntry): void {
    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[Logger.minLevel]) return;
    for (const adapter of Logger.adapters) {
      adapter.write(entry);
    }
  }

  private static async closeAdapters(adapters: LogAdapter[]): Promise<void> {
    for (const adapter of adapters) {
      await adapter.close?.();
    }
  }

  /**
   * 仅供测试使用：把 Logger 静态状态恢复到"刚加载、未 configure"的初始态，
   * 用于测试启动期 buffer 行为。生产代码不要调用。
   */
  static __resetForTesting(): void {
    Logger.adapters = [];
    Logger.minLevel = 'info';
    Logger.startupBuffer = { head: [], tail: [], dropped: 0 };
  }
}
