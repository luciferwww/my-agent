# Platform Logger Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: Logger, startup buffering, diagnostics, adapter lifecycle, and adapter close
> Ownership key: logging-and-adapter-lifecycle

---

## 1. 概述

`src/platform/logger/` 提供全局日志系统。核心设计：

- **静态类 `Logger`**：process-wide static state；所有模块通过 `Logger.get('ModuleName')` 获取 cached named instance
- **Adapter 模式**：ConsoleAdapter 和 FileAdapter 各自独立，Logger 不耦合输出目标
- **启动期 buffer**：在 `configure()` 调用前缓冲日志，首次 configure 后回放（drain），防止启动期日志丢失

---

## 2. 目录结构

```
src/platform/logger/
├── types.ts          # LogLevel / LogEntry / LogAdapter / LoggerConfig
├── Logger.ts         # Logger（静态类）+ LoggerInstance
├── ConsoleAdapter.ts # stdout/stderr 输出
├── FileAdapter.ts    # 日志文件（按日期滚动）
└── index.ts
```

---

## 3. 类型定义

```
LogLevel = 'debug' | 'info' | 'warn' | 'error'

LogEntry {
  level: LogLevel
  message: string
  module: string
  timestamp: Date
  context?: Record<string, unknown>
}

LogAdapter {
  write(entry: LogEntry): void    // 同步 fire-and-forget；adapter 内部按需异步队列
  start?(): Promise<void>         // configure 时调用
  close?(): Promise<void>         // 关闭时调用
  onError?: (err, entry) => void  // 写入失败回调
}
```

---

## 4. Logger（静态类）

### 4.1 API

```
Logger.configure(config: LoggerConfig): Promise<void>
  // 替换 adapter 列表，首次调用时 drain 启动期 buffer
  // 二次调用仅交换 adapters / minLevel，不重新启用 buffer

Logger.get(module: string): LoggerInstance
  // 按模块名返回实例，同名返回同一实例（Map 缓存）

Logger.write(level, module, message, context?): void
  // 内部分发入口，LoggerInstance 的四个方法都调这里

Logger.setLevel(level: LogLevel): void   // 运行时调整全局级别
Logger.close(): Promise<void>            // 关闭所有 adapter
```

### 4.2 LoggerInstance

```
const log = Logger.get('RuntimeBootstrap')
log.debug('context', { key: value })
log.info('...') / log.warn('...') / log.error('...')
```

每次调用转发到 `Logger.write(level, this.module, message, context)`。

### 4.3 启动期 buffer

在 `configure()` 被调用之前，所有 `write()` 调用进入 buffer，**不按 minLevel 过滤**（因为此时还不知道用户配的 minLevel）。

```
buffer 结构：
  head[]    ← 前 20 条，冻结不变（保留启动初期上下文）
  tail[]    ← 后 80 条，环形滚动（保留"出事前最后一帧"）
  dropped   ← 中间被挤掉的条数

首次 configure() → drain:
  1. 按新 minLevel 过滤 head[] 并 dispatch
  2. 若 dropped > 0，插入 warn sentinel 提示中间丢了 N 条
  3. 按新 minLevel 过滤 tail[] 并 dispatch
  4. startupBuffer = null（永久关闭，后续 write 直通 adapters）
```

二次 `configure()` 时 buffer 已为 null，直接跳过 drain。

---

## 5. ConsoleAdapter

```
ConsoleAdapterConfig {
  minLevel?: LogLevel    // 此 adapter 的最低输出级别（可独立于全局 minLevel）
  colors?: boolean       // 默认：TTY 环境开启
}
```

输出格式：`[LEVEL] HH:MM:SS.mmm [module] message {context?}`

- `error` 写 `process.stderr`，其他写 `process.stdout`
- 颜色：debug=white, info=cyan, warn=yellow, error=red

---

## 6. FileAdapter

```
FileAdapterConfig {
  dir: string            // 日志目录（绝对路径）
  prefix?: string        // 文件名前缀，默认 'app'→ app.2026-05-29.log
  minLevel?: LogLevel
  maxQueueSize?: number  // 内部队列上限，默认 10000；超出后丢弃并触发 onError
}
```

- `write()` 同步入队，异步 flush（append 到当日 `.log` 文件）
- `close()` 等待队列排空后关闭
- 跨日期：文件名含日期，自然按日滚动，不需要额外轮转逻辑

---

## 7. 关键设计决策

| 决策 | 说明 |
|---|---|
| 静态类 Logger | 全局唯一，所有模块直接 `import { Logger }`，无需依赖注入 |
| 启动期 head + tail buffer | head 保留启动初期上下文；tail 滚动保留"出事前最后一帧"；两段设计比单环形缓冲区更实用 |
| pre-configure 不按 minLevel 过滤 | configure 前不知道用户配的 minLevel，一律 buffer，drain 时再统一过滤 |
| adapter.write() 同步 | 调用方不 await——adapter 内部按需实现异步队列（FileAdapter 有队列，ConsoleAdapter 同步写） |
| adapter 级别独立于全局 | ConsoleAdapter / FileAdapter 各自可设 minLevel，支持"console 只看 warn+，文件记全量 debug"场景 |

`Logger.close()` owns adapter drain/close only. Runtime Builder owns aggregate Shutdown ordering, shared deadline accounting, and how Logger failures or deadline residuals appear in `RuntimeShutdownReport`. Closing Logger does not itself close Turns, Channels, generations, Memory, or Runtime Units.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [Logger.ts](../../../src/platform/logger/Logger.ts), [types.ts](../../../src/platform/logger/types.ts), [ConsoleAdapter.ts](../../../src/platform/logger/ConsoleAdapter.ts), [FileAdapter.ts](../../../src/platform/logger/FileAdapter.ts), [runtime-builder.ts](../../../src/runtime/runtime-builder.ts) |
| Tests | [Logger.test.ts](../../../src/platform/logger/Logger.test.ts), [ConsoleAdapter.test.ts](../../../src/platform/logger/ConsoleAdapter.test.ts), [FileAdapter.test.ts](../../../src/platform/logger/FileAdapter.test.ts), [runtime-builder.test.ts](../../../src/runtime/runtime-builder.test.ts), [ft-01-boundaries.test.ts](../../../src/architecture-fitness/ft-01-boundaries.test.ts) |
| Controlling authority | [Runtime Composition Module Spec](../runtime-composition-module-spec.md), [Target Architecture](../target-architecture.md) |
