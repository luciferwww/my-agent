# Session History Loading Specification

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-27
> Owner: Project owner
> Related Plan: [Session History Loading Plan](plan.md)
> Validation: [Session History Loading Validation](validation.md)

## 1. Purpose and observable outcome

Selecting a persisted Session in the bundled WebSocket client restores its
latest visible conversation records. The user can load earlier records while
the page preserves chronological order and the current scroll position.

History loading is a read-only projection of the Session's current active
branch. It does not alter Session metadata, the active leaf, permission mode,
Runtime execution, or Runner model history.

Every persisted message belongs to a started Turn. Realtime events remain a
temporary presentation; a terminal Turn event triggers a latest-page reload,
and persisted records sharing that `turnId` replace the temporary Turn state.

## 2. Scope

This Specification defines:

- the Core Session page query and display projection;
- required Turn correlation on persisted message records;
- the Runtime and Extension API capability;
- the WebSocket request, response, and error behavior;
- the bundled client's initial loading, earlier-page merge, terminal Turn
  convergence, and persisted Tool Call reconstruction behavior.

## 3. Non-goals

- Transcript, branch, Compaction, or Runner-history redesign.
- History response byte budgeting or additional Tool Result truncation.
- Original-image transfer or retrieval.
- Approval history reconstruction.
- New persisted IDs on realtime Agent events.
- Compatibility with Transcript records created before this Change.

## 4. Boundaries and dependency direction

Core Session owns Transcript access, active-branch resolution, pagination, and
display-safe projection. Runtime exposes that operation as a Channel-neutral
capability. The Extension API exports only immutable query and result values.
WebSocket owns wire validation and response routing. The bundled client owns
request state, visible item assembly, Tool pairing, and scroll behavior.

The WebSocket Extension must not access JSONL paths, `SessionManager`,
`TranscriptState`, or private Runtime modules.

## 5. Public and structural contracts

The public capability uses the following semantic contract:

```ts
interface SessionHistoryQuery {
  readonly sessionId: string;
  readonly beforeEntryId?: string;
  readonly limit?: number;
}

interface SessionHistoryMessage {
  readonly entryId: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly role: 'user' | 'assistant' | 'toolResult';
  readonly content: string | readonly Exclude<
    ContentBlock,
    Extract<ContentBlock, { type: 'image' }>
  >[];
  readonly abortMeta?: {
    readonly partial: boolean;
    readonly stopReason: 'aborted';
  };
}

interface SessionHistoryPage {
  readonly sessionId: string;
  readonly items: readonly SessionHistoryMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}
```

The Session capability adds one read operation equivalent to:

```ts
getHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage>;
```

The History content reuses the existing `ContentBlock` variants, including
image blocks. Image blocks retain their base64 source, MIME type, and
dimensions so persisted History can render the same attachment after terminal
convergence, page reload, or loading from another client. The exact type
location and name may follow the existing owner-module naming conventions, but
the semantics above are stable.

`MessageRecord` likewise requires `turnId: string`. Session roots and
Compaction records do not acquire a Turn identity.

## 6. Query behavior and invariants

- `beforeEntryId` is an optional exclusive `MessageRecord.id` cursor.
- Core first resolves the complete active branch as one chronological linear
  `MessageRecord[]`; pagination slices that array and never traverses branches
  page by page.
- Omitting it selects the latest page from the current active branch.
- Supplying it selects records strictly before that record.
- The default `limit` is 50 and the maximum is 100.
- `limit` counts `MessageRecord` values, including unmatched Tool Result
  records. It does not count content blocks or rendered UI items.
- Every response orders items from oldest to newest according to the resolved
  active branch. UUID values are never compared for ordering.
- `nextCursor` is the first returned item's `entryId` when older records remain.
- When no older records remain, `hasMore` is false and `nextCursor` is null.
- An empty branch returns no items, `hasMore: false`, and `nextCursor: null`.
- A cursor absent from the current active branch fails with
  `SESSION_HISTORY_CURSOR_INVALID`.
- Core rejects a non-integer or out-of-range `limit` with `TypeError` before
  reading the Transcript. WebSocket performs the same validation at the wire
  boundary and returns `INVALID_MESSAGE`; no History-specific limit error is
  introduced.

Normal appends do not invalidate an earlier cursor. If an explicit branch
change removes the cursor from the active path, only that page request fails.

Every returned item has a non-empty `turnId`. A user message emitted before
Turn start is not yet history. It becomes a persisted user record only after
its queued request starts and receives a Turn ID. Steering consumed by an
active Turn and every Assistant and ordinary Tool Result record produced by
that Turn use the same ID.

Orphan Tool Result repair is the exception to execution-time ownership. It may
run at the start of a later Turn, but semantically completes Tool Use blocks in
an earlier persisted Assistant record. The synthetic Tool Result inherits that
Assistant record's `turnId`; it does not use the recovery Turn's ID.

The existing event identities connect the pre-Turn and Turn phases without a
new protocol field. The origin client initially renders a pending local user
item. Its echoed `user_message` supplies `messageId`; because one client sends
ordinary requests in order, the client assigns it to the oldest pending local
item. `run_start.originMessageId` then assigns the emitted `turnId` to that
item. External user events already carry `messageId` directly.

A steering `user_message` creates no new Turn. The client attaches it to the
Session's one active Turn. If the client joined after `run_start` and does not
yet know that ID, it holds the steering item by `messageId` and attaches it to
the next turn-correlated event for that Session; Runtime guarantees that a
Session has at most one active Turn. A `request_end` for a queued request that
never starts uses `originMessageId` to settle the temporary item and produces
no History record.

## 7. Content projection

- String content and text blocks retain their complete persisted text.
- Image blocks retain their base64 source, MIME type, and dimensions.
- Tool Use blocks retain the persisted call ID, name, and input.
- Tool Result blocks retain the persisted Tool Use ID and complete persisted
  result content.
- Assistant `abortMeta` is preserved.
- Compaction records and the Transcript root are not returned.

The existing Session persistence cap remains the only Tool Result storage cap.
History adds no preview or transport truncation.

## 8. WebSocket protocol

Successful `hello` only makes the following request valid on the connection; it
does not itself trigger a History request. While the bundled client is in the
new-Session state, it sends no History request. After the user selects a
persisted Session, the client may request that Session's History using its
`sessionId`:

```json
{
  "type": "get_session_history",
  "requestId": "history-7",
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "beforeEntryId": "optional-entry-id",
  "limit": 50
}
```

`requestId` and `sessionId` are required non-empty strings.
`beforeEntryId`, when present, is a non-empty string. `limit`, when present, is
a positive integer no greater than 100.

Success returns only to the requesting socket:

```json
{
  "type": "session_history",
  "requestId": "history-7",
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

A capability operation failure after successful request parsing returns only
to the requesting socket:

```json
{
  "type": "session_history_error",
  "requestId": "history-7",
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "code": "SESSION_HISTORY_CURSOR_INVALID",
  "message": "The history cursor is not on the active branch."
}
```

The query does not join a Session audience and does not broadcast. Wire-shape
errors, including an invalid `limit`, retain the existing uncorrelated
`channel_error` shape because request parsing has not produced a valid History
request. Error messages must not expose Transcript paths, message content,
credentials, or underlying exception objects.

## 9. Browser behavior

### 9.1 Initial history

When a persisted Session is selected, the client clears that Session's stale
history request state, displays a loading state, and requests the latest page.
It accepts a response only when both `requestId` and `sessionId` match the
outstanding request.

The response becomes the chronological persisted baseline. Realtime events
remain temporary Turn state and may continue while History loads. History
items and temporary Turn state are separate collections until terminal
convergence. A late response for a different selection is ignored.

### 9.2 Earlier pages

When `hasMore` is true, the client exposes one load-earlier action. Only one
history request per Session may be outstanding. The request uses the current
`nextCursor`.

If a terminal event requests a latest-page refresh while any History request
for that Session is outstanding, the client records one pending latest refresh
instead of starting another request. After the outstanding request settles, it
sends one cursor-free latest-page request. Repeated terminal events coalesce
into that same pending refresh.

The server response is already ordered. The client prepends records preceding
the currently earliest displayed `entryId` and never compares UUID values.
It restores the prior top visible element's viewport offset after insertion.
Realtime events continue to append at the bottom while an earlier page loads.

An invalid cursor leaves all displayed history and realtime content intact.
The failed earlier-page request may be retried after the user reselects or
reloads the Session; the client does not automatically replace the view.

### 9.3 Tool Call reconstruction

Persisted Tool Use and Tool Result blocks reconstruct Tool Call cards under the
existing Tool Activity presentation rules. Approval cards are never inferred.

If a page contains a Tool Result whose Tool Use is not loaded, the client
caches the result by `tool_use_id` and does not render it independently. When
an earlier page supplies the Tool Use, the client attaches the cached result
to that Tool Call card. The Tool Result record still participates normally in
pagination and cursor calculation.

### 9.4 Terminal Turn convergence

Realtime text, Tool Call, and Tool Result presentation is grouped by `turnId`
and is not itself inserted into persisted History. On `run_end` or `error`,
the client requests the latest History page. Returned records merge into the
persisted collection by `entryId`.

If the response contains at least one record with the terminal `turnId`, the
client removes that Turn's temporary text and Tool activity. If no matching
persisted record exists, the client retains the temporary content. A Turn with
more records than the page size follows ordinary History behavior: the latest
records are shown and the user may load earlier records. The client does not
correlate individual deltas with individual `entryId` values.

Terminal notices are separate from persisted conversation records. An error,
queued cancellation, Abort notice, or configured-limit notice remains visible
after History convergence; the reload never treats it as persisted Assistant
content. A Turn with no persisted records therefore keeps its terminal notice
and removes no temporary content solely because the reload succeeded.

If the terminal reload fails, the temporary Turn presentation remains visible
and the History area exposes retry. This gives final consistency without
requiring every realtime event to know a future persisted record ID.

### 9.5 Deletion and failure

Deleting a Session clears its history items, unmatched Tool Result cache,
temporary Turn state, and outstanding request identity. Query failure
preserves already displayed content and leaves the Session selectable.

## 10. Lifecycle, concurrency, and resource ownership

Each query resolves the active branch visible when Core performs the query.
Transcript append-only behavior keeps older cursors stable during ordinary
conversation. No history lock spans WebSocket delivery or browser rendering.

The client owns temporary request and Turn-presentation state. The server
retains no history subscription, page cache, or replay state after responding.

## 11. Security and capabilities

History is available through the same Session capability and WebSocket
connection as existing Session metadata operations. This Change introduces no
new authentication or network exposure policy. Image base64 is excluded from
history responses to avoid transferring persisted binary payloads through the
display query.

## 12. Compatibility and migration

The capability and WebSocket messages are additive. Existing Channel
implementations are updated through the canonical capability contract; the
WebSocket Extension remains dependent only on the public Extension API.
Existing Transcript files are not migrated: `turnId` is required for all
messages read by this contract, and older Session data may be removed before
using the Change. No dual-read path, Feature Flag, or deprecated protocol alias
is introduced.

## 13. Acceptance and validation

1. Latest-page queries return at most 50 active-branch records in chronological order.
2. Valid cursors are exclusive and return at most the requested count.
3. `limit` counts messages, including unmatched Tool Result records.
4. Invalid or off-branch cursors return the stable cursor error.
5. Every persisted message has the owning Turn ID; queued messages dropped before start have no record.
6. Existing message/origin correlation assigns queued and steering temporary user items to the correct active Turn.
7. User, steering, Assistant, and Tool Result records retain the active Turn identity.
8. Synthetic orphan Tool Result repair inherits the repaired Assistant record's Turn identity.
9. Images return placeholders without base64; persisted Tool Results are complete.
10. Queries do not mutate active leaf, Session metadata, permission, or Runtime state.
11. History successes and operation errors are request-correlated, socket-local, and do not join audiences.
12. `hello` and the new-Session state do not trigger a History request.
13. Selecting a persisted Session restores its latest page while realtime Turn state remains temporary.
14. Earlier pages prepend in server order and preserve the scroll anchor.
15. Tool Use and Tool Result records pair correctly when split across pages.
16. `run_end` and `error` replace temporary text and Tool activity only after the latest page contains a matching Turn record.
17. Error, cancellation, Abort, and configured-limit notices survive History convergence.
18. A terminal reload with no matching persisted Turn records preserves temporary content.
19. Invalid cursors and other query failures preserve displayed content.
20. A terminal refresh concurrent with another History request is coalesced and runs once after settlement.
21. Fast Session switching and deletion discard stale responses and temporary state.
22. Existing Session, Turn, Tool Activity, Approval, permission, attachment, and routing tests remain green.
23. Relevant Unit and Integration tests, lint, build, documentation links, browser desktop/mobile checks, and `git diff --check` pass.

## 14. Open questions

None. Contract changes discovered during Delivery require Specification review
before implementation continues.
