# Logger 模块设计文档

> 状态：设计中，待确认
> 范围：Phase 1（Logger 全局注册表 + ConsoleAdapter + FileAdapter）

---

## 1. 背景与目标

### 问题

目前日志输出散落在各模块中（`console.log/warn/error`），没有统一格式、无法按模块过滤、无法切换输出目标。

### 目标

建立轻量日志模块：

- 统一的 `LogAdapter` 接口，支持多个并发 adapter
- 具名 Logger（Named Logger）模式——各模块按名称获取实例，无需注入
- 全局配置一次，所有实例共享同一套 adapter
- Phase 1 提供 `ConsoleAdapter` 和 `FileAdapter`

### 设计原则

| 原则 | 说明 |
|------|------|
| 具名 Logger | `Logger.get('ModuleName')` 随取随用，无构造注入 |
| adapter 自管生命周期 | `start()` / `close()` 由各 adapter 自行实现，Logger 负责编排 |
| `write()` 同步 | 热路径不阻塞调用方，adapter 内部自行处理异步 |
| configure 前 buffer + 回放 | 未调用 `configure()` 前 entry 进入内部启动期 buffer（head + ring tail），首次 `configure()` 时按用户配的 minLevel 过滤后回放到正式 adapters，buffer 永久关闭。这样既不丢启动关键信息，又完全尊重 `console.enabled` / `file.enabled` 等用户配置 |
| configure 后 minLevel 从 config 读取 | config 加载完成后，`Logger.configure()` 以 `AppConfig.logger.minLevel` 覆盖全局级别 |

### 不在 Phase 1 范围内

- `TelnetAdapter`（TCP 实时流）
- `DatabaseAdapter`
- 日志按大小轮转（FileAdapter 仅按日期轮转）
- 分布式 trace context 传播

---

## 2. 核心概念

```
应用入口
  └─ Logger.configure([ConsoleAdapter, FileAdapter])
              │
              └─ 内部 adapters 列表 + instances Map
                        │
          Logger.get('AgentRunner')
                        │
                  LoggerInstance { module: 'AgentRunner' }
                        │
              logger.info('turn started', { sessionKey })
                        │
                  构造 LogEntry { level, message, module, timestamp, context }
                        │
              遍历所有 adapters → adapter.write(entry)
                        │
              ┌─────────┴──────────┐
       ConsoleAdapter          FileAdapter
       (同步写 stdout)       (入队，异步写文件)
```

---

## 3. 类型定义（`src/platform/logger/types.ts`）

```typescript
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

/** AppConfig.logger 对应的配置段，来自 config.json */
export interface LoggerModuleConfig {
  /** 全局最低输出级别；默认 'info' */
  minLevel?: LogLevel;
  /** Console adapter 子配置 */
  console?: {
    /** 是否启用；默认 true */
    enabled?: boolean;
    /** 此 adapter 的最低输出级别；不设跟随全局 minLevel */
    minLevel?: LogLevel;
  };
  /** File adapter 子配置 */
  file?: {
    /** 是否启用；默认 false（不写文件） */
    enabled?: boolean;
    /** 日志文件目录；解释为相对 workspaceDir 的相对路径，默认 'logs' */
    dir?: string;
    /** 文件名前缀，默认 'app' → app.YYYY-MM-DD.log */
    prefix?: string;
    /** 此 adapter 的最低输出级别；不设跟随全局 minLevel */
    minLevel?: LogLevel;
    /** 内部队列上限，超出后丢弃并触发 onError；默认 10000 */
    maxQueueSize?: number;
  };
}
```

---

## 4. Logger（`src/platform/logger/Logger.ts`）

### 4.1 公开 API

```typescript
export class Logger {
  /**
   * 全局配置，替换当前 adapter 列表并依次调用 start()。
   * 须在应用入口调用一次。重复调用会先 close() 旧 adapter。
   */
  static async configure(config: LoggerConfig): Promise<void>;

  /**
   * 按模块名获取 LoggerInstance。
   * 相同 name 返回同一实例（内部 Map 缓存）。
   * configure() 前调用可正常使用，entry 静默丢弃。
   */
  static get(module: string): LoggerInstance;

  /**
   * 依次调用所有 adapter 的 close()，释放资源。
   * 应在进程退出前调用。
   */
  static async close(): Promise<void>;

  /**
   * 运行时调整全局最低级别（无需重新 configure）。
   */
  static setLevel(level: LogLevel): void;
}
```

### 4.2 LoggerInstance

```typescript
export class LoggerInstance {
  readonly module: string;

  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
```

### 4.3 内部结构

```typescript
// Logger 内部（静态私有）

// ── 正式态字段（configure() 之后生效） ──
// 注意：configure() 之前 adapters 必须为空数组，让所有 entry 都走 startupBuffer 分支；
// 不能在这里塞默认 ConsoleAdapter，否则启动期会"adapter 立即输出 + buffer 也存一份"，
// 回放时变成双倍输出，且绕过用户的 console.enabled 配置。
private static adapters: LogAdapter[] = [];
private static instances = new Map<string, LoggerInstance>();
private static minLevel: LogLevel = 'info';

// ── 启动期 buffer（仅 configure() 之前生效） ──
//
// 生命周期：
//   类加载            → startupBuffer = { head: [], tail: [], dropped: 0 }
//   write() 多次       → 进 head，head 满进 tail，tail 满环形挤掉旧 tail（dropped++）
//   首次 configure()  → drain 后 startupBuffer = null（永久关闭）
//   再次 configure()  → buf 已为 null，跳过 drain，仅交换 adapters
//
// 为什么要 head + tail 双段：
//   - head 保留启动初期的"why are we here"上下文（workspaceDir、agentId 等）
//   - tail 保留"出事前最后一帧"，调试启动 hang 时最关键
//   - dropped 计数让回放时插入 sentinel 提示"中间丢了 N 条"，避免读者困惑时间戳跳变
//
// 为什么 STARTUP_BUFFER_*_LIMIT 硬编码而非走 config：
//   纯属内部容错机制，启动正常 < 20 条永远不会爆；爆了说明上层有死循环。
//   暴露给用户调反而增加心智负担，无收益。
private static readonly STARTUP_BUFFER_HEAD_LIMIT = 20;
private static readonly STARTUP_BUFFER_TAIL_LIMIT = 80;

/**
 * Pre-configure 阶段的日志缓冲区。
 *
 * - 非 null：处于启动期，write() 把 entry 入 buffer 而非派发到 adapters
 * - null：已 configure，write() 直接派发；buffer 不会再被启用
 *
 * 用单个对象 + null 标志位，而非三个独立字段 + 一个 inStartup 布尔，
 * 是为了让"启动期是否结束"只有一个真相来源（startupBuffer === null），
 * 不会出现 head 已清但 dropped 没清的中间不一致态。
 */
private static startupBuffer: {
  head: LogEntry[];      // 前 STARTUP_BUFFER_HEAD_LIMIT 条，溢出后冻结不变
  tail: LogEntry[];      // 后 STARTUP_BUFFER_TAIL_LIMIT 条，溢出后环形挤掉最旧
  dropped: number;       // 中间被环形挤掉的条数（用于回放时插 sentinel）
} | null = { head: [], tail: [], dropped: 0 };

// 级别顺序
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

// ── write 派发逻辑 ──
//
// 注意：buffer 阶段不按 minLevel 过滤——此时还不知道用户配的 minLevel，
// 一律入 buffer，回放时再按 configure() 传入的 minLevel 统一过滤。
// 这样如果用户配了 'debug'，启动期的 debug 日志也能保留。
static write(level: LogLevel, module: string, message: string, context?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level, message, module,
    timestamp: new Date(),
    ...(context !== undefined ? { context } : {}),
  };

  const buf = Logger.startupBuffer;
  if (buf) {
    if (buf.head.length < Logger.STARTUP_BUFFER_HEAD_LIMIT) {
      buf.head.push(entry);
    } else if (buf.tail.length < Logger.STARTUP_BUFFER_TAIL_LIMIT) {
      buf.tail.push(entry);
    } else {
      // tail 已满，环形：丢最旧的 tail，把当前 entry 推入末尾
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

// ── configure：drain buffer 后永久关闭 ──
static async configure(config: LoggerConfig): Promise<void> {
  await Logger.closeAdapters(Logger.adapters);
  Logger.adapters = config.adapters;
  Logger.minLevel = config.minLevel ?? 'info';
  for (const a of Logger.adapters) await a.start?.();

  const buf = Logger.startupBuffer;
  Logger.startupBuffer = null;     // 启动期结束的唯一信号；之后 write() 不再走 buffer 分支
  if (!buf) return;                // 二次 configure：无 buffer 可 drain

  // 按 minLevel 过滤 + 派发到新 adapters
  for (const e of buf.head) Logger.dispatchFiltered(e);
  if (buf.dropped > 0) {
    Logger.dispatchFiltered({
      level: 'warn',
      module: 'Logger',
      message: `${buf.dropped} log entries dropped during startup buffer overflow`,
      timestamp: new Date(),
    });
  }
  for (const e of buf.tail) Logger.dispatchFiltered(e);
}

private static dispatchFiltered(entry: LogEntry): void {
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[Logger.minLevel]) return;
  for (const adapter of Logger.adapters) adapter.write(entry);
}
```

---

## 5. ConsoleAdapter（`src/platform/logger/ConsoleAdapter.ts`）

同步写 stdout/stderr，无需 `start` / `close`。

### 5.1 配置

```typescript
export interface ConsoleAdapterConfig {
  /** 此 adapter 的最低输出级别；默认继承全局 minLevel */
  minLevel?: LogLevel;
  /** 是否输出彩色（TTY 环境默认开启） */
  colors?: boolean;
}
```

### 5.2 输出格式

```
[2026-04-24T10:00:00.000Z] [INFO ] [AgentRunner] turn started {"sessionKey":"main"}
[2026-04-24T10:00:01.234Z] [WARN ] [SessionManager] session not found {"sessionKey":"x"}
[2026-04-24T10:00:02.000Z] [ERROR] [AgentRunner] LLM call failed {"error":"timeout"}
```

- `error` 级别写 `process.stderr`，其余写 `process.stdout`
- level 字段固定 5 字符宽，便于列对齐
- context 为空时不输出 `{}`

---

## 6. FileAdapter（`src/platform/logger/FileAdapter.ts`）

每行一条 JSONL，异步写文件，内部维护写队列。

### 6.1 配置

```typescript
export interface FileAdapterConfig {
  /** 日志文件目录 */
  dir: string;
  /** 文件名前缀；默认 'app' → app.2026-04-24.log */
  prefix?: string;
  /** 此 adapter 的最低输出级别；默认继承全局 minLevel */
  minLevel?: LogLevel;
  /** 内部队列上限，超出后丢弃并触发 onError；默认 10_000 */
  maxQueueSize?: number;
}
```

### 6.2 内部机制

```
write(entry)
  └─ queue.push(entry)        ← 同步，立即返回
        │
  setImmediate / microtask    ← 批量 flush 触发
        │
  appendFile(date-file, jsonl)
        │
  失败 → onError(err, entry)
```

- 文件名按日期切换（`app.2026-04-24.log`）——不跨天合并，无需额外轮转逻辑
- `close()` 等待队列全部写完后关闭文件句柄

### 6.3 JSONL 格式

```json
{"level":"info","module":"AgentRunner","message":"turn started","timestamp":"2026-04-24T10:00:00.000Z","context":{"sessionKey":"main"}}
```

### 6.4 查看 JSONL 日志

JSONL 文件可直接用 `jq` 转为 plain text 查看，无需修改代码：

```bash
# 实时跟踪（类 tail -f）
tail -f logs/app.2026-04-24.log | jq -r '"\(.timestamp) [\(.level)] [\(.module)] \(.message)"'

# 带 context
tail -f logs/app.2026-04-24.log | jq -r '"\(.timestamp) [\(.level)] [\(.module)] \(.message) \(if .context then (.context | tostring) else "" end)"'

# 只看 warn 以上
tail -f logs/app.2026-04-24.log | jq -r 'select(.level == "warn" or .level == "error") | "\(.timestamp) [\(.level)] [\(.module)] \(.message)"'

# 只看某个模块
tail -f logs/app.2026-04-24.log | jq -r 'select(.module == "AgentRunner") | "\(.timestamp) [\(.level)] \(.message)"'
```

#### Windows / WSL 实时跟踪的注意事项

如果 agent 跑在 Windows，而你想从 WSL 用 `tail -f /mnt/c/...` 跟踪日志，会发现**只能看到打开时的快照，不会实时更新**。这是 WSL2 的 9P 协议跨 Windows 文件系统的元数据缓存限制（不是 FileAdapter 的问题）。

两条可行路径：

**A. WSL 侧改用轮询（`tail -F` + 短间隔）**

```bash
tail -F -s 0.5 /mnt/c/.../logs/app.2026-05-09.log
# 仍不行的话，watch 强制重读
watch -n 1 'tail -20 /mnt/c/.../logs/app.2026-05-09.log'
```

**B. Windows 侧用 PowerShell（推荐，避开 WSL 边界）**

```powershell
# 纯实时 tail
Get-Content -Wait -Tail 20 C:\path\to\logs\app.2026-05-09.log

# JSON → plain text 渲染
Get-Content -Wait -Tail 20 C:\path\to\logs\app.2026-05-09.log `
  | ForEach-Object { $j = $_ | ConvertFrom-Json; "$($j.timestamp) [$($j.level)] [$($j.module)] $($j.message)" }

# 带 context（ConvertTo-Json 默认 depth=2，深嵌套需要 -Depth）
Get-Content -Wait -Tail 20 C:\path\to\logs\app.2026-05-09.log `
  | ForEach-Object {
      $j = $_ | ConvertFrom-Json
      $ctx = if ($j.context) { ' ' + ($j.context | ConvertTo-Json -Compress -Depth 10) } else { '' }
      "$($j.timestamp) [$($j.level)] [$($j.module)] $($j.message)$ctx"
    }
```

---

## 7. 使用示例

```typescript
// 应用入口（config 加载完成后立即调用）
// configure() 前 Logger 已使用默认 ConsoleAdapter(minLevel:'info')
// configure() 后切换为根据 AppConfig.logger 拼装的 adapter 集合
const appConfig = loadConfig({ workspaceDir });

const adapters: LogAdapter[] = [];
if (appConfig.logger.console?.enabled !== false) {
  adapters.push(new ConsoleAdapter({
    minLevel: appConfig.logger.console?.minLevel,
  }));
}
if (appConfig.logger.file?.enabled) {
  const fileCfg = appConfig.logger.file;
  adapters.push(new FileAdapter({
    dir: path.join(workspaceDir, fileCfg.dir ?? 'logs'),
    prefix: fileCfg.prefix,
    minLevel: fileCfg.minLevel,
    maxQueueSize: fileCfg.maxQueueSize,
  }));
}
await Logger.configure({
  adapters,
  minLevel: appConfig.logger.minLevel ?? 'info',
});

// 进程退出前
await Logger.close();
```

`config.json` 示例（启用 file adapter，console 保持默认）：

```json
{
  "logger": {
    "minLevel": "info",
    "file": {
      "enabled": true,
      "dir": "logs",
      "minLevel": "debug"
    }
  }
}
```

```typescript
// AgentRunner.ts
const logger = Logger.get('AgentRunner');
logger.info('turn started', { sessionKey: params.sessionKey });
logger.error('LLM call failed', { error: err.message });
```

```typescript
// 测试（静默丢弃，不污染测试输出）
beforeEach(async () => {
  await Logger.configure({ adapters: [], minLevel: 'error' });
});
```

---

## 8. 对其它模块的改动

### 8.1 `src/platform/config/types.ts`

新增 `LoggerModuleConfig`，并加入 `AppConfig` 和 `ConfigFile`：

```diff
+/** Logger 配置 */
+export interface LoggerModuleConfig {
+  /** 全局最低输出级别；默认 'info' */
+  minLevel?: LogLevel;
+}

 export interface AppConfig {
   workspaceDir: string;
   agents: AgentsConfig;
+  logger: LoggerModuleConfig;
 }

 export interface ConfigFile {
   agents?: { ... };
+  logger?: LoggerModuleConfig;
 }
```

### 8.2 config 默认值

`loadConfig()` 内部以 `DEFAULT_LOGGER_CONFIG`（定义在 `src/platform/config/defaults.ts`）作为兜底，并 `deepMerge` 文件中的 `logger` 段：

```typescript
export const DEFAULT_LOGGER_CONFIG: LoggerModuleConfig = {
  minLevel: 'info',
  console: { enabled: true },
  file: { enabled: false, dir: 'logs', prefix: 'app', maxQueueSize: 10_000 },
};
```

> 设计取舍：默认不启用 FileAdapter（向后兼容当前只输出到 stdout 的行为）；
> `file.dir` 只接受相对 `workspaceDir` 的相对路径，绝对路径不在本期支持范围内。

### 8.3 `src/platform/logger/` （新增模块）

见 §8 文件结构。

---

## 9. 文件结构

```
src/platform/logger/
  types.ts          # LogLevel / LogEntry / LogAdapter / LoggerConfig / LoggerModuleConfig
  Logger.ts         # 全局注册表 + LoggerInstance
  ConsoleAdapter.ts # 同步写 stdout/stderr
  FileAdapter.ts    # 异步写 JSONL 文件
  index.ts          # 导出
```

---

## 10. 设计决策记录

| 问题 | 决策 | 依据 |
|------|------|------|
| 为什么用具名 Logger 而非注入？ | 日志是横切关注点，注入会让每个类的构造函数多一个参数，成本高；具名 Logger 是 log4j/log4js 的经典模式，使用更自然 | |
| 为什么 `write()` 同步？ | 日志调用遍布热路径，异步会让所有调用点变 await，现有代码改动量大 | adapter 内部用队列隔离异步，调用方不感知 |
| 为什么 adapter 自管生命周期？ | 各 adapter 的初始化和资源释放逻辑差异大（Console 无需、File 需要 flush、Telnet 需要 TCP server）；统一接口 + 各自实现比 Logger 集中管理更内聚 | |
| configure 前为什么用启动期 buffer 而非默认 ConsoleAdapter？ | 默认 ConsoleAdapter 方案虽然简单，但会无视用户的 `console.enabled: false` / `file.enabled: true` 配置——启动日志总是打到 stdout、永远进不了文件。改用 buffer + 回放后，启动期日志先憋在内部，`configure()` 时才按用户最终配置过滤+派发到正式 adapters，做到"既不丢启动信息，又完全尊重用户配置" | 详见 §4.3。代价：从未调 `configure()` 的进程会完全没有日志输出（buffer 一直憋着），所以约束所有 entrypoint 必须调 `configure()` |
| 启动期 buffer 为什么 head + tail 双段而非单纯环形？ | 单纯 FIFO 环形会丢启动初期的"why are we here"上下文（workspaceDir、agentId 等）；只保留尾部环形则丢启动 hang 之前的"最后一帧"。head 保上下文 + tail 保 recency 是两全方案，符合本项目工具结果截断已有的 head/tail 范式（见 [defaults.ts](../../src/platform/config/defaults.ts) 的 `toolResultHeadChars` / `toolResultTailChars`） | drain 时插入 sentinel 警告"中间丢了 N 条"，避免读者困惑时间戳跳变 |
| minLevel 为什么从 AppConfig 读而非 AgentDefaults？ | Logger 是全局单例，不是 per-agent 的资源，配置归属顶层 `AppConfig` 更准确 | |
| FileAdapter 为什么按日期切换文件？ | 按大小轮转需要 rename + 原子切换逻辑较复杂；按日期切换实现简单，且日志文件天然按时间可查 | Phase 2 再考虑按大小轮转 |
| 为什么不用第三方库？ | 遵循 coding-standards.md §10 约定 | |

---

## 11. Phase 2 预留

| 项目 | 说明 |
|------|------|
| `TelnetAdapter` | 启动 TCP server，实时推送日志流给连接的 client |
| `DatabaseAdapter` | 写入 SQLite 或其它 DB，支持结构化查询 |
| 按大小轮转 | FileAdapter 支持 `maxFileSizeBytes`，超出后 rename + 新建 |
| 子级别过滤 | 每个 LoggerInstance 可设自己的 minLevel，覆盖全局配置 |
| Trace context | 关联 turnId / sessionKey，无需每次手传 context |
