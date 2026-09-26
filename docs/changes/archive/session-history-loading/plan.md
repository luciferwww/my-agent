# Session History Loading Plan

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-27
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Session History Loading Specification](session-history-loading-specification.md)
> Validation: [Session History Loading Validation](validation.md)
> Authorization: Plan and Specification accepted for Delivery by the project owner on 2026-09-27.
> Acceptance: Accepted and archived by the project owner on 2026-09-27.

## 1. Outcome

Allow the WebSocket client to restore persisted conversation history when a
Session is selected or the page is refreshed. Load the latest records first
and page toward older records. Persist the owning `turnId` on every message
record so the client can replace one Turn's temporary realtime presentation
with its authoritative persisted records after the Turn settles.

## 2. Problem

The WebSocket client can list and select persisted Sessions, but selection
only changes page-local state. Existing Transcript messages are not loaded,
so a refresh or Session switch presents an empty conversation until new
events arrive.

Loading the entire active branch at once would make response and browser work
grow with Session lifetime. The existing active-branch projection already has
stable `MessageRecord.id` values and chronological ordering, so bounded
reverse pagination can restore the visible conversation without redesigning
the Transcript.

## 3. Scope

- Add a Core Session query for a page of the current active branch.
- Require `turnId` on every persisted `MessageRecord`.
- Persist user messages only after their queued item starts a Turn; associate
  injected steering, Assistant, and Tool Result records with the active Turn.
- Preserve the repaired Assistant record's `turnId` on a synthetic orphan Tool
  Result written by a later recovery Turn.
- Use optional exclusive `beforeEntryId` and a bounded `MessageRecord` count.
- Return each page in chronological order from oldest to newest.
- Project images to text placeholders without returning persisted base64.
- Return complete persisted text, Tool Use input, and Tool Result content.
- Expose the query through Runtime and the public Extension API.
- Add correlated WebSocket request and response messages.
- Load the latest page when the bundled client selects a persisted Session.
- Load older pages at the top while preserving the visible scroll anchor.
- Rebuild Tool Call cards from persisted Tool Use and Tool Result records,
  including pairs split across pages.
- Correlate a temporary user item through the existing
  `user_message.messageId -> run_start.originMessageId -> turnId` path.
- Keep realtime presentation temporary and reload the latest History page when
  a Turn reaches `run_end` or `error`; replace its temporary text and Tool
  activity by `turnId` while retaining non-persisted terminal notices.
- Add focused Core, Runtime, protocol, and browser-client coverage.

## 4. Non-goals

- Changing Transcript branching, Compaction, or Runner model history.
- Adding a response byte budget or a second Tool Result truncation policy.
- Returning original image data or adding an image retrieval endpoint.
- Persisting or reconstructing Approval cards.
- Adding a persisted ID to realtime events or correlating individual deltas
  with individual records.
- Redesigning Session lifecycle operations or the WebSocket audience model.

## 5. Ownership and dependency direction

```text
Core Session
  -> active-branch pagination and display-safe content projection

Runtime
  -> Channel-neutral history capability

Extension API
  -> immutable query and page contracts

WebSocket Channel
  -> wire validation, request correlation, requesting-socket response

Bundled HTML client
  -> loading, page merge, Tool pairing, scroll preservation, presentation
```

The WebSocket Extension uses only `my-agent/extension-api` and never reads
Transcript files or imports private Core/Runtime modules.

## 6. Delivery slices

| Slice | Status | Outcome | Exit condition |
|---|---|---|---|
| SHL-1 Core query and public capability | Complete | Required Turn correlation, active-branch pagination, and display projection reach the Extension API | Focused Core and Runtime contract tests pass |
| SHL-2 WebSocket protocol | Complete | Correlated History success/error responses reach the requesting socket | WebSocket protocol tests pass |
| SHL-3 Browser interaction | Complete | Initial restore, older-page loading, Tool pairing, and terminal Turn convergence work in the bundled client | Focused client behavior and desktop/mobile checks pass |
| SHL-4 Validation and authority | Complete | Stable docs reflect delivered behavior and required gates are recorded | Validation record is complete; two unrelated environment/baseline exceptions are documented |

Only one Slice may be `In Progress`.

## 7. Compatibility and migration

The WebSocket protocol change is additive. Existing Session, Turn, Approval,
permission, and event messages keep their current meaning. Transcript records
created before this Change are outside the migration scope and may be deleted;
there is no legacy-record reader, optional `turnId`, Feature Flag, or dual path.

## 8. Validation strategy

- Core tests for latest-page selection, exclusive cursors, count limits,
  chronological order, required Turn correlation, active branches, invalid
  cursors, and image projection.
- Runtime and Extension API contract tests for the narrow capability.
- WebSocket tests for parsing, defaults, limits, requesting-socket routing,
  correlation, errors, and no audience mutation.
- Client checks for initial loading, message-to-Turn correlation, older page
  insertion, scroll anchoring, cross-page Tool Result pairing, terminal Turn
  replacement, Session switching, deletion, and retry behavior.
- Regression coverage for existing Session, Turn, Tool Card, Approval,
  permission, attachment, and event-routing behavior.
- `npm test`, relevant Integration tests, `npm run lint`, `npm run build`,
  documentation links, browser desktop/mobile checks, and `git diff --check`.

## 9. Exit conditions

- Every acceptance scenario in the Specification is covered or explicitly
  recorded as blocked.
- Current Architecture and the stable Channel/Session Specifications describe
  the implemented contract.
- No unrelated Session lifecycle or client rendering work is included.
