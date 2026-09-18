# Session Persistence

> Status: Current Authority
> Authority: Current implemented Session behavior
> Verified: 2026-09-18
> Ownership: Session metadata, Transcript JSONL, message trees, branching, and persistence behavior
> Ownership key: session-and-transcript-persistence

## 1. Boundary

`src/core/session/` persists Session metadata and conversation history: user messages, Assistant messages, Tool Result batches, partial-abort metadata, and Compaction records. `src/runtime/session/` owns process-local Pending registrations, first-message admission, idle checks, and the application-facing Session lifecycle. [Runner](runner.md) remains the sole owner of user-message persistence and converts persisted history into Provider-neutral messages. Runtime owns queueing and Parent/Child execution lifecycle.

Persisted Sessions and transient Subagent Transcripts share the Transcript implementation but not visibility. A transient Child has root provenance and no Store entry, so it is absent from Session get/list and lifecycle operations.

Session does not own Memory indexing or recall; those belong to [Memory](memory.md).

## 2. Files and storage

```text
<agentHome>/sessions/
├── sessions.json          # versioned metadata index keyed by sessionId
├── <sessionId>.jsonl      # one append-only Transcript per persisted Session
└── ...
```

The metadata index avoids scanning Transcript files to locate a Session. Each Transcript line is one JSON object:

| Record | Purpose |
|---|---|
| `SessionRecord` | First-line file metadata, including Transcript version |
| `MessageRecord` | A `user`, `assistant`, or internal `toolResult` message |
| `CompactionRecord` | A summary plus the first retained message identifier and Compaction statistics |

The Store accepts only version 1 and entries whose key matches their canonical UUID `sessionId`. A missing Store yields an empty Store, while invalid or unsupported data fails closed. Startup removes temporary materialization files and canonical Transcript files without matching Store entries.

Malformed or empty JSONL lines are skipped when loading. A persisted Session with a missing Transcript fails rather than becoming empty. Store replacement is the visibility commit point for materialization.

## 3. Data contracts

### 3.1 Session metadata

```text
SessionEntry {
  sessionId: string
  createdAt: number
  updatedAt: number
  title?: string
  archivedAt?: number
  forkedFromSessionId?: string
}
```

`sessionId` is the immutable server-issued identity, Store key, Runtime concurrency key, routing key, and Transcript filename stem. Title is mutable display metadata. Active/queued status is derived from Runtime state and is not persisted.

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

## 4. Session lifecycle

```text
SessionCoordinator.createSession()
  -> { sessionId }                 # Pending only

SessionCoordinator.admitMessage(sessionId, content)
  -> { entry: SessionEntry }       # materializes on first accepted message

SessionCoordinator.listSessions({ archived? })
SessionCoordinator.getSession(sessionId)
SessionCoordinator.renameSession(sessionId, title)
SessionCoordinator.archiveSession(sessionId)
SessionCoordinator.unarchiveSession(sessionId)
SessionCoordinator.deleteSession(sessionId)
SessionCoordinator.forkSession(sessionId, entryId?)

SessionManager.materializeSession(input)
SessionManager.createTransientSubagentTranscript(input)
SessionManager.deleteTransientSubagentTranscript(sessionId)

SessionManager.appendMessage(sessionId, message)
  -> new message id

SessionManager.getMessages(sessionId)
  -> current branch's MessageRecord[]

SessionManager.branch(sessionId, entryId)
SessionManager.getLeafId(sessionId)

SessionManager.appendCompactionRecord(sessionId, record, firstKeptEntryId)
SessionManager.getLastCompactionSummary(sessionId)
SessionManager.getLastCompactionRecord(sessionId)
```

`createSession()` allocates a canonical UUID in a bounded process-local Pending registry. Pending registrations expire after 30 minutes, are capped at 4096, disappear on restart, create no files, and are invisible to get/list. Selecting a new Session in a client does not allocate even a Pending registration; the first submitted message creates the registration and immediately sends with its ID.

First-message admission is serialized per `sessionId`. A live Pending ID materializes one root-only Transcript and one Store entry using the Pending `createdAt` plus a deterministic title derived from the first usable user text. Admission does not persist message content; Runner appends the admitted user message exactly once after preflight. Unknown or expired IDs fail, and archived Sessions reject new messages.

List returns non-archived Sessions by default and archived Sessions only when requested. Rename trims non-null titles and allows `null` to clear them. Archive, delete, and fork require an idle persisted Session; unarchive and rename do not. Delete rejects a Session with persisted fork descendants and has no cascade. Fork copies the selected linear message path into a new persisted Session with a fresh UUID.

Subagent setup creates a root-only transient Transcript with `{ type: 'subagent', callerSessionId }` provenance and no Store entry. Runner appends the Child prompt. Runtime deletes the Transcript at terminal cleanup, and startup removes orphaned transient files after interruption.

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
4. updates Session metadata time while keeping Compaction statistics in the Transcript record.

The latest Compaction is selected by ISO timestamp. Runner uses `firstKeptEntryId` to discard older history from the invocation view and prepends the summary; the original JSONL records remain intact.

## 8. Concurrency and durability

Transcript appends and metadata read-modify-write operations use an in-process, per-file Promise queue. Operations targeting the same path execute in request order, operations for different paths can proceed independently, and lock state is released after success or failure.

This is process-local serialization, not an inter-process filesystem lock. Transcript files are append-only, but `sessions.json` is rewritten after each locked mutation.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [SessionManager.ts](../../src/core/session/SessionManager.ts), [SessionCoordinator.ts](../../src/runtime/session/SessionCoordinator.ts), [PendingSessionRegistry.ts](../../src/runtime/session/PendingSessionRegistry.ts), [types.ts](../../src/core/session/types.ts), [transcript.ts](../../src/core/session/transcript.ts), [store.ts](../../src/core/session/store.ts), [lock.ts](../../src/core/session/lock.ts) |
| Tests | [SessionManager.v1.test.ts](../../src/core/session/SessionManager.v1.test.ts), [SessionCoordinator.test.ts](../../src/runtime/session/SessionCoordinator.test.ts), [PendingSessionRegistry.test.ts](../../src/runtime/session/PendingSessionRegistry.test.ts), [title.test.ts](../../src/core/session/title.test.ts), [transcript.test.ts](../../src/core/session/transcript.test.ts), [store.test.ts](../../src/core/session/store.test.ts), [AgentRunner.test.ts](../../src/core/runner/AgentRunner.test.ts) |
| Controlling authority | [ADR-015: Session Identity and Materialization](../decisions/adr-015-session-identity-and-materialization.md), [Runner Turn Flow](../specifications/runner-turn-flow.md), [Abort](../specifications/abort.md) |
