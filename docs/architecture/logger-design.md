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
| configure 前默认输出到 console | 未调用 `configure()` 前使用内置默认 ConsoleAdapter（minLevel 硬编码为 'info'），避免丢失启动关键信息 |
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

## 3. 类型定义（`src/logger/types.ts`）

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
}
```

---

## 4. Logger（`src/logger/Logger.ts`）

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
// configure() 前使用默认 ConsoleAdapter，避免丢失启动关键信息
private static adapters: LogAdapter[] = [new ConsoleAdapter({ minLevel: 'info' })];
private static instances = new Map<string, LoggerInstance>();
private static minLevel: LogLevel = 'info';

// 级别顺序
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

// LoggerInstance.write 内部实现
private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[Logger.minLevel]) return;
  const entry: LogEntry = {
    level, message, context,
    module: this.module,
    timestamp: new Date(),
  };
  for (const adapter of Logger.adapters) {
    adapter.write(entry);
  }
}
```

---

## 5. ConsoleAdapter（`src/logger/ConsoleAdapter.ts`）

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

## 6. FileAdapter（`src/logger/FileAdapter.ts`）

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

---

## 7. 使用示例

```typescript
// 应用入口（config 加载完成后立即调用）
// configure() 前 Logger 已使用默认 ConsoleAdapter(minLevel:'info')
// configure() 后切换为用户指定的 adapter 集合
const config = await loadConfig(workspaceDir);

await Logger.configure({
  adapters: [
    new ConsoleAdapter(),
    new FileAdapter({ dir: path.join(workspaceDir, 'logs') }),
  ],
  minLevel: config.logger?.minLevel ?? 'info',
});

// 进程退出前
await Logger.close();
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

### 8.1 `src/config/types.ts`

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

`loadConfig()` 的硬编码默认值中新增：

```diff
+logger: {
+  minLevel: 'info',
+},
```

### 8.3 `src/logger/` （新增模块）

见 §8 文件结构。

---

## 9. 文件结构

```
src/logger/
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
| configure 前为什么用默认 ConsoleAdapter 而非静默丢弃？ | 启动阶段（config 加载、路径解析、DB 初始化）的日志往往是最关键的，静默丢弃会导致问题难以排查 | minLevel 此时硬编码为 'info'，与 config 文件无关（config 尚未加载）；configure() 调用后才切换到 config 指定的级别 |
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
