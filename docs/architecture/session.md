# Session Persistence

> Status: Current Authority
> Authority: Current implemented Session behavior
> Verified: 2026-11-04 (message identity, ancestor retention, whole-Turn History and LLM-call metadata)
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
| `ToolExecutionAcceptedRecord` | Host ownership of one admitted call and its `executionId` |
| `ToolExecutionTerminalRecord` | One durable execution outcome and content |
| `HostTaskCompletionRecord` | Exactly-once trusted completion delivery for an execution |
| `TurnAbortedRecord` | Structural Root-Abort boundary |
| `CompactionRecord` | A summary plus the first retained message identifier and Compaction statistics |

The Store accepts only version 1 and entries whose key matches their canonical UUID `sessionId`. A missing Store yields an empty Store, while invalid or unsupported data fails closed. Startup removes temporary materialization files and canonical Transcript files without matching Store entries.

Malformed non-empty JSONL and structurally invalid records fail closed. Empty
lines are ignored. A persisted Session with a missing Transcript fails rather
than becoming empty. Store replacement is the visibility commit point for
materialization.

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

Every record has an `id`, `parentId`, and ISO-8601 `timestamp`. Every
`MessageRecord` also has the required `turnId` of its owning Turn. Message
records may carry a top-level `messageId` correlating realtime presentation
with History. It is separate from the record `id` and is never part of the
model message payload. Existing entry IDs and parent links are unchanged.
Internal Tool execution facts keep their call/execution identities and do
not acquire message IDs merely because History projects their state.
Real Assistant responses may also carry top-level `llmRound`, a non-negative
safe integer recording the zero-based Model-call round. It is not a unique
identity and never enters the model message payload. Other roles cannot carry
it, and legacy or synthetic messages do not receive a fabricated round.
Message content is either text or canonical content blocks. Persisted Tool Result blocks
require `status: success | error | denied | aborted`; legacy missing-status
records fail closed. `toolResult` is an internal
persisted role; Runner projects it as a `user` role for Provider-neutral
invocation without changing the stored role.

Async lifecycle records are parented to their owning Assistant message and are
validated relationally on load. History folds `execution_id`, terminal
`status`, and `result_content` into the corresponding Tool Use. A trusted Host
completion projects as `role: 'user', origin: 'host'` locally; Provider
encoders remove the local marker while Channel/steering input cannot create it.

User messages may store the original reasoning preference as structured
metadata. Omission, an empty object, and explicit `effort: 'default'` remain
distinct persisted forms even though they resolve to the same execution
policy. The metadata is not projected into Provider user content. Fork and
reload preserve it, while later messages do not inherit it.

Assistant messages may carry:

```text
abortMeta {
  partial: boolean
  stopReason: 'aborted'
}
```

This metadata survives JSONL round trips. Runner does not send it to Providers; it uses it for recovery and filters legacy empty partial Assistant records from invocation history.

Transcript v2 Assistant messages may also carry invocation identity, Provider
source facts, completion state, and ordered Thinking blocks. Complete Thinking
stores normalized display text plus an opaque Provider-owned JSON replay
envelope; partial Thinking stores text only. A v2 Thinking block requires its
Assistant invocation. Valid v1/v2 Transcripts remain readable. New Transcripts
use v3; an existing file is atomically upgraded before its first messageId,
llmRound or presentation append, preserving existing record IDs and leaving old records without a
fabricated mapping. Invocation/Thinking without messageId requires at least
v2 and never downgrades v3. Fork preserves the selected path's messageId,
invocation and internal replay state. Older binaries that only accept v1/v2
reject v3; rollback requires a compatible reader or explicit migration.

Paginated History is a presentation projection. It exposes Thinking
`id/text/status` but never invocation source or replay payload. User History
also exposes the original structured reasoning preference so clients can
rebuild a summary without persisting display text. A stored messageId is
projected unchanged; no invocation metadata is exposed to provide it.
Stored llmRound is also projected unchanged; each marked Assistant entry is
an independent call group even when another entry has the same round.

`PresentationRecord` retains a descendant fact in every ancestor, with its
real `sourceSessionId`, `sourceEntryId` and a whitelisted `body`. Message
bodies retain messageId, llmRound and safe Thinking, never invocation/replay metadata.
Tool accepted/terminal facts and Subagent start/end links are separate body
variants. Each copy is parented to the captured delegating Assistant message;
steering cannot move that anchor. Copies never advance the active message
leaf, enter model Context, or become new propagation sources.

Orchestration awaits start retention before publishing `subagent_start`,
registers resolved Children as recursive Parents, and awaits end retention
before publishing `subagent_end` or releasing tree membership. Source message
and Tool writes release their own lock before awaiting ancestor writes.
Copies are idempotent by source fact (lifecycle by Child and phase). User input
copies additionally match source Session, Turn and nonempty messageId within
the target's existing write lock: an identical retry retains the first copy
and its sourceEntryId, while conflicting bodies or anchors fail explicitly.
This does not merge other roles, Turns, sources, different IDs or legacy inputs
without IDs. Source JSONL attempt entries remain unchanged. A submitted input
remains an ancestor display fact after source-tail cleanup; model branch
rollback is not input retraction. Target IO failures propagate explicitly.
This is not a cross-file
transaction or a crash-repair queue. Ancestor History remains readable after
the original Child files are removed.

Ancestor copy failures log source/target identities, the failing phase
(`validate_target`, `append_transcript`, or `update_metadata`), and the underlying
error message/name and available filesystem code/syscall, without message or
Tool-result payloads. The thrown `SESSION_PERSISTENCE_FAILED` retains its original
cause. A metadata update failure can occur after the presentation is already
durable; the diagnostic does not imply rollback or change retry behavior.

A `CompactionRecord` stores `summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter`, `trigger`, and `droppedMessages`. Its trigger is `preemptive`, `overflow`, or `manual`.

## 4. Session lifecycle

```text
SessionCoordinator.createSession()
  -> { sessionId }                 # Pending only

SessionCoordinator.admitMessage(sessionId, content)
  -> { entry: SessionEntry }       # materializes on first accepted message

SessionCoordinator.listSessions({ archived? })
SessionCoordinator.resolveSession(sessionId)
SessionCoordinator.renameSession(sessionId, title)
SessionCoordinator.archiveSession(sessionId)
SessionCoordinator.unarchiveSession(sessionId)
SessionCoordinator.deleteSession(sessionId)
SessionCoordinator.forkSession(sessionId, entryId?)

SessionPermissionRegistry.initialize(sessionId, mode?)
SessionPermissionRegistry.get(sessionId)
SessionPermissionRegistry.set(sessionId, mode, changedByClientId?)
SessionPermissionRegistry.delete(sessionId)

SessionManager.materializeSession(input)
SessionManager.createTransientSubagentTranscript(input)
SessionManager.retainTransientSubagentTranscript(sessionId)
SessionManager.deleteTransientSubagentTranscript(sessionId)
SessionManager.close()

SessionManager.appendMessage(sessionId, message)
  -> persisted MessageRecord

SessionManager.getMessages(sessionId)
  -> current branch's MessageRecord[]

SessionManager.getHistory({ sessionId, beforeEntryId?, limit? })
  -> latest or earlier active-branch page in chronological order

SessionManager.branch(sessionId, entryId)
SessionManager.getLeafId(sessionId)

SessionManager.appendCompactionRecord(sessionId, record, firstKeptEntryId)
SessionManager.getLastCompactionSummary(sessionId)
SessionManager.getLastCompactionRecord(sessionId)
```

`createSession()` allocates a canonical UUID in a bounded process-local Pending registry. Pending registrations expire after 30 minutes, are capped at 4096, disappear on restart, create no files, and are invisible to get/list. Selecting a new Session in a client does not allocate even a Pending registration; the first submitted message creates the registration and immediately sends with its ID.

Each live root Session also has a process-local `manual | allow_all` permission state. It is intentionally absent from `SessionEntry`, Transcript, configuration, Memory, and Agent Context. Client disconnect and Turn completion preserve it in the current Runtime. Archive and delete clear it; unarchive and fork initialize `manual`; Runtime restart or resume also starts `manual`. Transient Child Sessions have no independent permission state and read their root Session's current mode.

First-message admission is serialized per `sessionId`. A live Pending ID materializes one root-only Transcript and one Store entry using the Pending `createdAt` plus a deterministic title derived from the first usable user text. Admission does not persist message content; Runner appends the admitted user message exactly once after preflight. Unknown or expired IDs fail, and archived Sessions reject new messages.

List returns non-archived Sessions by default and archived Sessions only when requested. Rename trims non-null titles and allows `null` to clear them. Archive, delete, and fork require an idle persisted Session; unarchive and rename do not. Delete rejects a Session with persisted fork descendants and has no cascade. Runtime validates deletion, cleans Session-owned managed processes, revalidates, and only then commits deletion so cleanup failure remains retryable. Fork copies the selected linear message path plus related lifecycle records into a new persisted Session with a fresh UUID; managed processes are not inherited.

Subagent setup creates a root-only transient Transcript with
`{ type: 'subagent', callerSessionId }` provenance and no Store entry. Runner
appends the Child prompt. After `subagent_end`, SessionManager keeps the
terminal Transcript resolvable and readable for 24 hours using an unreferenced
timer; observation does not extend the deadline. Runtime Builder shutdown
calls `SessionManager.close()` to delete retained Transcripts early, before
managed-process cleanup; startup removes orphaned transient files after
interruption.

History uses a default threshold of 50 and accepts limits from 1 through 100.
It accumulates whole local Turns, newest first, until the candidate message
count reaches the threshold, then returns chronological Turns and target-file
append order within each Turn. Native messages and anchored descendant
message copies count; lifecycle facts only enrich the projection. Output may
exceed 100. `beforeEntryId` must name the first candidate of an active Turn,
and excludes that entire Turn; interior and off-branch cursors are rejected.
Copied items expose their real source identity; `scopes` carries recursive
Child links and terminal state. A missing end is running only when this target
still has a live route, otherwise unknown. A running snapshot is not a
terminal replacement.
History projection removes image base64 and emits a MIME/dimensions text
placeholder while preserving persisted text, Tool Use input, folded execution
identity/status/result content, and Assistant abort metadata.

## 5. Message tree and branching

Each Transcript entry points to its parent. `resolveLinearPath(state, leafId)` follows parents back to the root, retains only native message records, and reverses the result into conversation order.

`branch()` changes only the in-memory `leafId`; it does not rewrite JSONL. Later appends form a new branch from that point, while abandoned records remain auditable. Lifecycle, Compaction and presentation records never become the active message leaf; both initial serialization and reload select the last Session/message record so in-process and restarted fork behavior is identical.

History includes presentation only when its anchor remains on that active
path. Fork preserves native IDs and copies the selected path's visible
presentation facts in original append order. An explicit message cut excludes
later copies; an omitted cut snapshots current retained facts. A fork needs
neither the source nor Child files to read those facts, and does not inherit
live presentation routes.
Within that existing copy pass, direct `subagent_start/end` bodies whose
`callerSessionId` equals the source Session are rebound to the fork Session.
Other fields, descendant relationships and source records remain unchanged.

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
| Tests | [SessionManager.lifecycle.test.ts](../../src/core/session/SessionManager.lifecycle.test.ts), [SessionCoordinator.test.ts](../../src/runtime/session/SessionCoordinator.test.ts), [PendingSessionRegistry.test.ts](../../src/runtime/session/PendingSessionRegistry.test.ts), [title.test.ts](../../src/core/session/title.test.ts), [transcript.test.ts](../../src/core/session/transcript.test.ts), [store.test.ts](../../src/core/session/store.test.ts), [AgentRunner.test.ts](../../src/core/runner/AgentRunner.test.ts) |
| Controlling authority | [ADR-015: Session Identity and Materialization](../decisions/adr-015-session-identity-and-materialization.md), [ADR-020: Session-addressed Presentation Subscription and Ephemeral Child Observation](../decisions/adr-020-session-addressed-presentation-subscription-and-ephemeral-child-observation.md), [Channel Specification](../specifications/channel.md), [Subagent Specification](../specifications/subagent.md), [Runner Turn Flow](../specifications/runner-turn-flow.md), [Abort](../specifications/abort.md) |
