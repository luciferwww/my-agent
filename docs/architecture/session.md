# Session Persistence

> Status: Current Authority
> Authority: Current implemented Session behavior
> Verified: 2026-09-16
> Ownership: Session metadata, Transcript JSONL, message trees, branching, and persistence behavior
> Ownership key: session-and-transcript-persistence

## 1. Boundary

`src/core/session/` persists conversation history: user messages, Assistant messages, Tool Result batches, partial-abort metadata, and Compaction records. [Runner](runner.md) decides when records are appended and converts persisted history into Provider-neutral messages. Runtime owns queueing and Parent/Child execution lifecycle. Session owns only the persisted `spawnedBy` relationship and each Child's isolated transcript.

Session does not own Memory indexing or recall; those belong to [Memory](memory.md).

## 2. Files and storage

```text
<agentHome>/sessions/
├── sessions.json          # metadata index keyed by sessionKey
├── <sessionId>.jsonl      # one append-only Transcript per Session
└── ...
```

The metadata index avoids scanning Transcript files to locate a Session. Each Transcript line is one JSON object:

| Record | Purpose |
|---|---|
| `SessionRecord` | First-line file metadata, including Transcript version and optional working directory |
| `MessageRecord` | A `user`, `assistant`, or internal `toolResult` message |
| `CompactionRecord` | A summary plus the first retained message identifier and Compaction statistics |

Malformed or empty JSONL lines are skipped when loading. A missing Transcript yields an empty in-memory state; a missing metadata store yields an empty store, while other store read errors propagate.

## 3. Data contracts

### 3.1 Session metadata

```text
SessionEntry {
  sessionId: string
  sessionKey: string
  sessionFile: string
  createdAt: number
  updatedAt: number
  status?: 'running' | 'done' | 'failed'
  abortedLastRun?: boolean
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  compactionCount?: number
  spawnedBy?: string
}
```

`sessionKey` is the caller-facing logical identity. `sessionId` is an internal UUID used in the Transcript filename.

### 3.2 Transcript entries

Every record has an `id`, `parentId`, and ISO-8601 `timestamp`. Message content is either text or canonical content blocks. `toolResult` is an internal persisted role; Runner projects it as a `user` role for Provider-neutral invocation without changing the stored role.

Assistant messages may carry:

```text
abortMeta {
  partial: boolean
  stopReason: 'aborted'
}
```

This metadata survives JSONL round trips. Runner does not send it to Providers; it uses it for recovery and filters legacy empty partial Assistant records from invocation history.

A `CompactionRecord` stores `summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter`, `trigger`, and `droppedMessages`. Its trigger is `preemptive`, `overflow`, or `manual`.

## 4. SessionManager behavior

```text
createSession(key, opts?)
  -> SessionEntry

resolveSession(key, opts?)
  -> { entry: SessionEntry, isNew: boolean }

getSession(key)
  -> SessionEntry | undefined

listSessions()
  -> SessionEntry[]

updateSession(key, fields)
deleteSession(key)

appendMessage(key, message)
  -> new message id

getMessages(key)
  -> current branch's MessageRecord[]

branch(key, entryId)
getLeafId(key)

appendCompactionRecord(key, record, firstKeptEntryId)
getLastCompactionSummary(key)
getLastCompactionRecord(key)
```

Creating a Session generates UUIDs, creates the directory and first `session` JSONL record, initializes the in-memory Transcript, and updates the metadata store under its per-file queue. Duplicate keys fail. Deletion is idempotent for a missing Session and removes the metadata, Transcript file when present, and cached state.

`updateSession()` merges fields and always refreshes `updatedAt`. Appending a message persists first, updates the `byId` map and `leafId`, and refreshes metadata time.

## 5. Message tree and branching

Each Transcript entry points to its parent. `resolveLinearPath(state, leafId)` follows parents back to the root, retains only message records, and reverses the result into conversation order.

`branch()` changes only the in-memory `leafId`; it does not rewrite JSONL. Later appends form a new branch from that point, while abandoned records remain auditable. On reload, the last valid physical record—including a Compaction marker—becomes the default leaf; parent traversal still resolves the most recently appended conversation branch.

```text
session root
  └─ user #1
      ├─ assistant branch A
      └─ assistant branch B   <- active after the latest append or explicit branch
```

## 6. Tool Result storage cap

When both `toolResultHeadChars` and `toolResultTailChars` are configured on `SessionManager`, every `tool_result` block longer than their sum is capped before persistence. The stored content keeps the configured head and tail with a visible trimming marker; non-Tool blocks pass through unchanged. If either option is absent or falsy, no storage cap is applied.

This is a one-time disk boundary. Runner also has separate in-memory context-budget pruning, which does not rewrite persisted data.

## 7. Compaction records

Appending a Compaction record:

1. sets its `parentId` to the current leaf;
2. writes it to JSONL and indexes it in `byId`;
3. does not move `leafId`, because the record is a marker rather than a conversation message;
4. increments `compactionCount` and updates metadata time.

The latest Compaction is selected by ISO timestamp. Runner uses `firstKeptEntryId` to discard older history from the invocation view and prepends the summary; the original JSONL records remain intact.

## 8. Concurrency and durability

Transcript appends and metadata read-modify-write operations use an in-process, per-file Promise queue. Operations targeting the same path execute in request order, operations for different paths can proceed independently, and lock state is released after success or failure.

This is process-local serialization, not an inter-process filesystem lock. Transcript files are append-only, but `sessions.json` is rewritten after each locked mutation.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [SessionManager.ts](../../src/core/session/SessionManager.ts), [types.ts](../../src/core/session/types.ts), [transcript.ts](../../src/core/session/transcript.ts), [store.ts](../../src/core/session/store.ts), [lock.ts](../../src/core/session/lock.ts) |
| Tests | [SessionManager.test.ts](../../src/core/session/SessionManager.test.ts), [transcript.test.ts](../../src/core/session/transcript.test.ts), [store.test.ts](../../src/core/session/store.test.ts), [lock.test.ts](../../src/core/session/lock.test.ts), [AgentRunner.test.ts](../../src/core/runner/AgentRunner.test.ts) |
| Controlling authority | [Runner Turn Flow](../specifications/runner-turn-flow.md), [ADR-002: Context Budgeting and Compaction Recovery](../decisions/adr-002-context-budgeting-and-compaction-recovery.md), [Abort](../specifications/abort.md) |
