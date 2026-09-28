# Session History Loading Validation

> Status: Accepted and Archived with two documented environment/baseline exceptions
> Date: 2026-09-27
> Owner: Project owner
> Plan: [Session History Loading Plan](plan.md)
> Specification: [Session History Loading Specification](session-history-loading-specification.md)

## Delivered behavior

- Every persisted `MessageRecord` carries one top-level `turnId`.
- Core returns chronological pages from the complete active branch with an exclusive `beforeEntryId` cursor, default limit 50, and maximum 100.
- History projection replaces persisted image base64 with MIME/dimensions text and preserves persisted Tool content.
- Runtime exposes the read-only query through the public Session capability.
- WebSocket supports socket-local correlated History success and operation-error responses without joining an audience.
- The bundled client requests no History on `hello` or in new-Session state; selecting a persisted Session loads its latest page.
- Persisted History and realtime state remain separate until terminal convergence by `turnId`; older pages preserve the scroll window and Tool Result pairing.
- The obsolete `SessionManager.v1.test.ts` name was removed. Its unique lifecycle coverage now lives in `SessionManager.lifecycle.test.ts`; redundant transcript-level coverage was removed.

## Validation results

| Check | Result |
|---|---|
| Focused affected tests | Pass: 175/175 after the persisted-record shape fix |
| Full Unit suite | Functional code passes; 1,146 passed, 1 skipped; one unrelated Windows symlink test failed before exercising product code because the process lacked symlink permission |
| Integration suite | Pass: 18/18 |
| WebSocket Channel Unit | Pass: 39/39 |
| Copilot Relay Unit through build | Pass: 46/46 |
| Lint | Pass |
| Build and Host build audit | Pass; audit covered 336 files |
| Architecture Fitness FT-12 | Pass: 6/6 after authority synchronization |
| Remaining Fitness | All other files pass except FT-09, which fails on the branch's pre-existing missing top-level `clients/` directory |
| Browser desktop | Pass: selected persisted Session restored user, Assistant, and Tool Call records; no horizontal overflow (`1253 == 1253`) |
| Browser mobile 390px viewport | Pass: no page or chat-log horizontal overflow (`375 == 375`, `369 == 369`) |
| Session switching | Pass: two persisted Sessions loaded independently without cross-session contamination |
| `git diff --check` | Pass |

## Post-archive review corrections

The 2026-09-28 implementation review identified and corrected three gaps:

- Earlier-page insertion now restores the first visible message's viewport
  offset after Vue updates the DOM.
- Failed History requests retain their cursor and terminal Turn IDs, expose a
  Retry action, and preserve terminal convergence across a later latest-page
  request.
- Transcript loading now fails closed when a message has a missing, empty, or
  whitespace-only `turnId`.

Focused Transcript and SessionManager tests pass (26/26), WebSocket Channel
tests pass (39/39), TypeScript and workspace lint pass, and the Host build and
WebSocket Host verification pass. Browser automation measured a `0px` scroll
anchor delta after prepending an earlier page and confirmed that a failed
terminal refresh retries with its original Turn ID before removing temporary
Turn presentation.

## Exceptions

1. `src/platform/config/agent-config-bootstrap.test.ts` could not create a file symlink on this Windows process (`EPERM`). This is an OS privilege/environment failure unrelated to Session History Loading.
2. `src/architecture-fitness/ft-09-doc-governance.test.ts` scans a top-level `clients/` directory that does not exist on this branch. This known repository baseline issue predates this Change.

Neither exception changes the implemented History behavior or its focused, integration, lint, build, browser, and governing architecture evidence.
