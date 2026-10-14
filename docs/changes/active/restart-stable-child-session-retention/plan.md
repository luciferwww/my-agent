# Restart-stable Child Session Retention Plan

> Status: Accepted
> Date: 2026-10-13
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Restart-stable Child Session Retention Specification](specification.md)
> Authorization: The project owner accepted the bounded behavior and authorized implementation on 2026-10-13.

## 1. Outcome

Keep a completed or restart-interrupted Subagent Session addressable across
Runtime restarts for the remainder of a fixed 24-hour retention period.
Persist the minimum Child identity and lifecycle metadata in the existing
Session Store so startup no longer deletes a retained Child Transcript as an
orphan.

## 2. Scope

- Extend the existing Session Store to accept ordinary Chat entries and
  explicitly typed Subagent entries.
- Register a Child in the Store only after its Transcript is created.
- Persist terminal outcome, completion time, and absolute expiration time.
- On startup, restore unexpired terminal Children and their remaining timers.
- On startup, mark a Child without terminal metadata as `interrupted` and
  retain its partial Transcript for 24 hours from that startup.
- Remove an expired or explicitly deleted Child from both the Store and disk.
- Stop deleting retained Child Transcripts during graceful Runtime shutdown.
- Keep Chat discovery and management behavior unchanged.

## 3. Non-goals

- Automation Session persistence.
- A generic Session Registry framework or SQLite migration.
- Child listing, rename, archive, fork, permission, resume, or send support.
- Resuming interrupted Subagent execution.
- Importing legacy orphan Child files that have no Session Store entry.
- Changing WebSocket messages, client state, or Child presentation.
- Changing the fixed 24-hour retention duration.

## 4. Delivery items

| Item | Status | Exit condition |
|---|---|---|
| RCR-1 Store contract | Complete | Current Chat entries retain their shape and typed Child entries validate |
| RCR-2 Child lifecycle persistence | Complete | Create, terminal, explicit delete, and graceful close preserve Store/Transcript invariants |
| RCR-3 Restart recovery | Complete | Unexpired terminal and interrupted Children recover with absolute TTL |
| RCR-4 Validation | Complete | Focused tests, lint, build, documentation, and diff checks pass |

Only one item may be `In Progress`.

## 5. Compatibility

No Store version field or migration path is introduced. Existing
`sessions.json` files may be discarded for this Change. Public
`SessionEntry`, `listSessions`, Chat CRUD, and wire contracts remain
unchanged.

## 6. Exit gate

The Change is complete when:

- a retained Child survives a real SessionManager close/reinitialize cycle;
- restart does not extend a terminal Child's absolute expiration;
- an interrupted Child receives a persisted 24-hour recovery expiration;
- expired and explicitly deleted Children remove Store and Transcript state;
- ordinary Chat lifecycle regression tests pass;
- the project owner accepts manual restart validation.

## 7. Validation record

Validated on 2026-10-13:

- 36 focused Store, Session lifecycle, and Subagent orchestration tests passed.
- 166 affected Session coordination, Runtime, WebSocket, and client tests
  passed.
- The complete unit suite passed all 1430 tests across 115 files.
- Repository lint, TypeScript, Vue type-check, production build, client asset
  verification, the 352-file Host build audit, and all 109 Relay tests passed.
- The production build emitted the existing environment warning that Node.js
  20.16.0 is below Vite's recommended 20.19 minimum; the build completed
  successfully.
- Automated implementation validation is complete. Project-owner manual
  restart acceptance remains the final Change exit gate.
