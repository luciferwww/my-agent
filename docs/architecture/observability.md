# Observability

> Status: Current Authority
> Authority: Current implemented observability behavior
> Verified: 2026-11-18
> Ownership: process-wide logging, startup buffering, log adapters, and adapter close
> Ownership key: logging-and-adapter-lifecycle

---

## 1. Purpose and boundary

`src/platform/logger/` provides the process-wide logging facility:

- `Logger` owns static process state, named logger-instance caching, global level filtering, adapter configuration, and the one-time startup buffer.
- `config.ts` owns Logger's document leaf contract, immutable defaults, and semantic validation.
- `ConsoleAdapter` formats human-readable process output.
- `FileAdapter` queues and appends JSON Lines records to UTC date-named files.

Logger does not own Runtime event contracts, Registry diagnostic classification, aggregate Shutdown ordering, or Provider diagnostics. [Runtime](runtime.md) projects startup diagnostics and owns the shared Shutdown deadline and report; `Logger.close()` only drains or closes configured log adapters.

## 2. Source layout

```text
src/platform/logger/
├── config.ts
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
2. starts candidate adapters in array order, publishing the new list and
   global minimum level (`info` by default) only after successful initialization;
3. on partial initialization failure, closes attempted adapters in reverse
   order, reports cleanup failures directly to stderr and preserves the primary
   startup failure and buffered entries;
4. on the first configuration only, drains the startup buffer through the new global level filter.

`Logger.setLevel(level)` changes the global threshold immediately. After startup, an entry below the global threshold is not sent to any adapter. Adapters can apply a second, independent minimum level.

A later `configure()` swaps adapters and level but never recreates the startup buffer. `Logger.close()` attempts to close all adapters in order, aggregates failures and clears the list even when closing fails. Logging after close is silently discarded because startup buffering remains permanently disabled and no adapter is installed.

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
| `dir` | Required output directory; `start()` creates it recursively and opens/verifies the current regular log file. |
| `prefix` | Filename prefix; defaults to `app`. |
| `minLevel` | Optional adapter-local threshold. |
| `maxQueueSize` | Maximum queued entries; defaults to `10_000`. |

`write()` ignores entries after close and below its local threshold. Otherwise it synchronously enqueues the entry and schedules an asynchronous flush. A full queue drops the new entry and reports the loss.

A flush groups queued entries by the UTC date derived from each entry timestamp and appends compact JSONL records to `<prefix>.YYYY-MM-DD.log`. Each record contains `level`, `module`, `message`, an ISO timestamp, and `context` only when provided.

Startup and the first write after the UTC date advances clean recognized regular
files older than the current date and six preceding dates. Deletion matches the
exact adapter prefix and valid filename date; unrelated, future-dated, directory
and symlink entries are not removed. File work is serialized with appends/close.
There is no timer, size rotation or disk quota.

Append and queue failures produce an emergency stderr diagnostic with operation
and available filesystem code, never the failed payload or raw error text.
Reporting is once per uninterrupted append-failure episode, once per queue
overflow until the queue drains below the bound, and once per cleanup-failure
episode until successful cleanup. An optional `onError` callback receives the
sanitized diagnostic and one representative entry for append/overflow episodes;
callback failure is reported directly, not recursively. These failures do not
stop the Agent. Cleanup failure retains files and does not fail usable logging.
`close()` stops admission and drains pending file work. Any recorded write loss
makes close reject, even after later successful appends; Runtime attributes
that failure instead of claiming complete log persistence.

## 8. Runtime integration

Runtime Bootstrap always configures File logging under `<agentHome>/logs/`
before the optional Console adapter and before Extension Acquisition.
`RuntimeAppOptions.consoleLogging` defaults true; Standalone explicitly sets it
false with `--cli` and true otherwise. Runtime does not inspect concrete Channels
or TTY state. The document contains levels, not output-enable switches.
Global and adapter-local levels remain separate.

An initialization failure prevents Runtime startup and reaches the Host's fatal
stderr/exit-status path. Ordinary CLI presentation and emergency file-failure
diagnostics remain visible even when Console logging is suppressed.

Registry startup diagnostics are Runtime-owned. Runtime includes the original optional Unit error message in the local operator log, while stable `warning` events expose only the accepted code, identity, phase, and generic message. Error objects, stacks, causes, and additional Extension payloads remain excluded. Runtime Composition also observes successfully published Channel completions and logs failed outcomes once with bounded Channel ID/phase fields; concrete Hosts retain process policy without duplicating those logs. Runtime decides how Logger close success, failure, or deadline exhaustion appears in the immutable `RuntimeShutdownReport`.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [Logger](../../src/platform/logger/Logger.ts), [logging types](../../src/platform/logger/types.ts), [console adapter](../../src/platform/logger/ConsoleAdapter.ts), [file adapter](../../src/platform/logger/FileAdapter.ts), [Runtime bootstrap](../../src/runtime/composition/bootstrap.ts), [Runtime Builder](../../src/runtime/composition/runtime-builder.ts) |
| Tests | [Logger tests](../../src/platform/logger/Logger.test.ts), [console adapter tests](../../src/platform/logger/ConsoleAdapter.test.ts), [file adapter tests](../../src/platform/logger/FileAdapter.test.ts), [Runtime Builder tests](../../src/runtime/composition/runtime-builder.test.ts), [real temporary-Home logging tests](../../src/hosts/standalone/logging.integration.test.ts), [Standalone Host tests](../../src/hosts/standalone/standalone-host.test.ts) |
| Controlling authority | [ADR-014](../decisions/adr-014-extension-packages-and-runtime-composition.md), [Runtime Composition](../specifications/runtime-composition.md) |
