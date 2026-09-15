# Observability

> Status: Current Authority
> Authority: Current implemented observability behavior
> Verified: 2026-09-14
> Ownership: process-wide logging, startup buffering, log adapters, and adapter close
> Ownership key: logging-and-adapter-lifecycle

---

## 1. Purpose and boundary

`src/platform/logger/` provides the process-wide logging facility:

- `Logger` owns static process state, named logger-instance caching, global level filtering, adapter configuration, and the one-time startup buffer.
- `ConsoleAdapter` formats human-readable process output.
- `FileAdapter` queues and appends JSON Lines records to UTC date-named files.

Logger does not own Runtime event contracts, Registry diagnostic classification, aggregate Shutdown ordering, or Provider diagnostics. [Runtime](runtime.md) projects startup diagnostics and owns the shared Shutdown deadline and report; `Logger.close()` only drains or closes configured log adapters.

## 2. Source layout

```text
src/platform/logger/
├── Logger.ts
├── ConsoleAdapter.ts
├── FileAdapter.ts
├── types.ts
└── index.ts
```

## 3. Logging contract

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  module: string;
  timestamp: Date;
  context?: Record<string, unknown>;
}

interface LogAdapter {
  write(entry: LogEntry): void;
  start?(): Promise<void>;
  close?(): Promise<void>;
  onError?: (error: Error, entry: LogEntry) => void;
}
```

`write()` is synchronous and fire-and-forget at the Logger boundary. An adapter may implement asynchronous work internally.

`Logger.get(module)` caches one `LoggerInstance` per module name. Its `debug`, `info`, `warn`, and `error` methods attach that module name and delegate to `Logger.write()`.

## 4. Configuration and global filtering

`Logger.configure({ adapters, minLevel })`:

1. closes the previously configured adapters in array order;
2. replaces the adapter list and global minimum level (`info` by default);
3. calls each new adapter's optional `start()` in array order;
4. on the first configuration only, drains the startup buffer through the new global level filter.

`Logger.setLevel(level)` changes the global threshold immediately. After startup, an entry below the global threshold is not sent to any adapter. Adapters can apply a second, independent minimum level.

A later `configure()` swaps adapters and level but never recreates the startup buffer. `Logger.close()` closes adapters in order and clears the adapter list. Logging after close is silently discarded because startup buffering remains permanently disabled and no adapter is installed.

## 5. Startup buffer

Before the first successful call reaches the drain step of `configure()`, `Logger.write()` buffers every level without applying `minLevel`. The fixed-capacity structure is:

```text
head: first 20 entries, then frozen
tail: latest 80 entries after the head
dropped: number displaced from the rolling tail
```

The first configuration sets the startup-buffer reference to `null`, then replays:

1. filtered head entries;
2. a filtered Logger `warn` sentinel when `dropped > 0`;
3. filtered tail entries.

The sentinel states how many entries were dropped during startup overflow. With overflow, this preserves both initial startup context and the most recent pre-configuration events.

## 6. Console adapter

`ConsoleAdapter` accepts optional `minLevel` and `colors`. Colors default to whether standard output is a TTY.

Without color, each record has this shape:

```text
[2026-04-24T10:00:00.000Z] [INFO ] [ModuleName] message {"optional":"context"}
```

The timestamp is an ISO-8601 UTC string, level labels are fixed-width uppercase labels, and optional context is serialized as compact JSON. `error` records go to standard error; all other levels go to standard output. When colors are enabled, the complete line is wrapped in level-specific ANSI color codes: debug white, info cyan, warn yellow, and error red.

## 7. File adapter

`FileAdapter` accepts:

| Option | Behavior |
|---|---|
| `dir` | Required output directory; `start()` creates it recursively. |
| `prefix` | Filename prefix; defaults to `app`. |
| `minLevel` | Optional adapter-local threshold. |
| `maxQueueSize` | Maximum queued entries; defaults to `10_000`. |

`write()` ignores entries after close and below its local threshold. Otherwise it synchronously enqueues the entry and schedules an asynchronous flush. If the queue is full, it drops the new entry and invokes `onError` with the dropped entry.

A flush groups queued entries by the UTC date derived from each entry timestamp and appends compact JSONL records to `<prefix>.YYYY-MM-DD.log`. Each record contains `level`, `module`, `message`, an ISO timestamp, and `context` only when provided. Append failures invoke `onError` once per affected entry. `close()` prevents new writes, waits for an active flush, and flushes any remainder.

## 8. Runtime integration

Runtime bootstrap derives Logger adapters from application configuration. Console logging is enabled unless explicitly disabled; file logging is opt-in and writes under `<workspaceDir>/logs/`. Runtime's global and adapter-local configured levels remain separate.

Registry startup diagnostics are not raw Logger entries or Provider-owned events. Runtime converts accepted diagnostic codes into stable Host-owned `warning` events and omits raw Extension errors from that event contract. Runtime also decides how Logger close success, failure, or deadline exhaustion appears in the immutable `RuntimeShutdownReport`.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [Logger](../../src/platform/logger/Logger.ts), [logging types](../../src/platform/logger/types.ts), [console adapter](../../src/platform/logger/ConsoleAdapter.ts), [file adapter](../../src/platform/logger/FileAdapter.ts), [Runtime bootstrap](../../src/runtime/bootstrap.ts), [Runtime Builder](../../src/runtime/runtime-builder.ts) |
| Tests | [Logger tests](../../src/platform/logger/Logger.test.ts), [console adapter tests](../../src/platform/logger/ConsoleAdapter.test.ts), [file adapter tests](../../src/platform/logger/FileAdapter.test.ts), [Runtime Builder tests](../../src/runtime/runtime-builder.test.ts) |
| Controlling authority | [Runtime Composition](../specifications/runtime-composition.md), [Architecture Foundation target](../changes/active/architecture-foundation/target-architecture.md) |
