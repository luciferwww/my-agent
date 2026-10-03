# Session Identity and Management Plan

> Status: Archived and Validated
> Date: 2026-09-18
> Accepted: 2026-09-18
> Validated: 2026-09-18
> Archived: 2026-09-18
> Owner: Project owner
> Decision: [ADR-015: Session Identity and Materialization](../../../decisions/adr-015-session-identity-and-materialization.md)
> Specification: [Session Management Specification](session-management-specification.md)
> Validation record: [Validation](validation.md)
> Research input: [New Session Model Design Draft](../../../research/session-model-design-draft.md)
> Authorization: Delivery approved by the project owner on 2026-09-18

## 1. Outcome

Replace caller-defined Session identity with one server-issued `sessionId`, separate mutable title metadata from identity, materialize Sessions only on their first message, and expose explicit Session management semantics without retaining the old Store format.

## 2. Scope

- New Session metadata and Store format.
- Transcript paths derived only from `sessionId`.
- Bounded process-local Pending Session registration.
- Deterministic local initial-title derivation.
- Session create, list, get, rename, archive, unarchive, delete, fork, send, and stop contracts.
- Migration of Session-scoped Runtime state and public Channel protocols from `sessionKey` to `sessionId`.
- Focused, contract, integration, lint, and build validation proportional to each delivery slice.

## 3. Non-goals

- Production implementation before explicit post-review approval.
- Reading or migrating an existing Session Store.
- Cloud synchronization, multi-process writers, or distributed Pending registration.
- CLI/TUI visual design beyond the minimum commands needed by an approved delivery slice.
- Redesigning Transcript message trees, Compaction, Provider history, or Session-consumer internals.
- LLM-generated Session titles.

## 4. Readiness gates

Delivery may start only after all items are true:

- [x] ADR-015 is `Accepted`.
- [x] The Session Management Specification is `Accepted`.
- [x] The project owner explicitly approves entering implementation after document review.
- [x] `<agentHome>/sessions/` is confirmed empty in the target environment. Local development and manual checks use the workspace-managed `test-workspace` Agent Home.
- [x] Review accepts or amends the proposed Pending TTL/capacity and idle-only lifecycle operations.
- [x] Materialization commit, retry, and orphan-cleanup semantics have no unresolved contract question.
- [x] Focused tests and final validation commands are agreed.

## 5. Delivery items

| Item | Status | Scope | Exit condition |
|---|---|---|---|
| SIM-0 Contract acceptance | Completed | Review ADR, Specification, policy constants, failure semantics, and boundaries | ADR and Specification accepted; implementation separately authorized |
| SIM-1 Persistence model | Completed | Store v1, immutable ID, derived path, prior-field disposition, title, materialize, archive, fork/delete rules | Session contract tests pass; no old Store reader, duplicate first message, or dual path |
| SIM-2 Application and Runtime identity | Completed | Pending Registry, first-send orchestration, per-Session maps and status, transient Subagent Transcripts | Pending/failure/concurrency tests pass; Runtime uses `sessionId`; Subagents remain absent from Session discovery |
| SIM-3 Channel and caller migration | Completed | Session capability, WebSocket protocol, minimum CLI flow, old field removal | Real callers use `sessionId`; protocol contract and integration tests pass |
| SIM-4 Validation and authority transfer | Completed | Review, broader checks, Current Architecture and stable Specification updates | Required checks pass; Change accepted and archived |

Only one delivery item may be `In Progress` at a time. Advancing an item requires the preceding exit condition.

Target note: the prior default Agent Home Session data was removed outside this Change. Local development and manual checks use `C:\dev\my-agent\my-agent\test-workspace`, whose `sessions/` directory was absent when Delivery began on 2026-09-18.

## 6. Validation strategy

### SIM-1 focused validation

- Session Store and Transcript unit tests.
- Materialization fault-injection and retry tests.
- Initial-title Unicode grapheme tests.
- Archive, fork, descendant-delete, and immutable-field contract tests.
- Removal tests for prior identity, status, usage-summary, and Compaction-summary metadata fields.

### SIM-2 focused validation

- Pending expiry and capacity tests using an injected clock.
- Concurrent first-send tests for one Session.
- Runner-owned exactly-once first-message persistence and Provider-input tests.
- Same-Session serialization and cross-Session concurrency tests.
- Stop and archived-admission behavior tests.
- Transient Subagent Transcript visibility, provenance, and terminal cleanup tests.

### SIM-3 focused validation

- Channel protocol tests for Session CRUD and `sessionId`-only messages.
- WebSocket audience and reconnect tests relevant to Session identity.
- Minimum CLI caller flow and one library/runtime caller migration.
- Repository search proving the retired Session API fields are absent from the approved boundary.

### Final gate

The final proposed checks are `npm test`, relevant Integration and Fitness suites, `npm run lint`, and `npm run build`. Per project policy, the complete expensive validation set requires explicit approval after focused implementation and review fixes are complete.

## 7. Compatibility and cutover

- Preconditions: target Session directory is empty.
- Compatibility paths: none.
- Feature flag: none.
- Old and new Session formats never run concurrently.
- SIM-3 removes the old public and Runtime Session identity path after all in-scope callers migrate.

## 8. Stop conditions

Pause and return to design review if implementation evidence requires any of the following:

- a second production Session identity or dual-format Store;
- a distributed/shared Pending registry;
- a change to Transcript tree or Compaction semantics;
- a new cross-module dependency direction;
- a materialization path that can expose an incomplete Session;
- broader consumer redesign rather than identity-field migration.

## 9. Review checklist

- [x] Scope remains Session-only.
- [x] Proposed policy choices are acceptable.
- [x] Public errors and lifecycle transitions are complete.
- [x] Materialization recovery is implementable on supported filesystems.
- [x] No compatibility branch is required.
- [x] Test scope matches risk without exhaustive internal permutations.

## 10. Completion and authority transfer

This Change completed SIM-4 and transferred authority as follows:

1. ADR-015 remains the durable identity and materialization decision;
2. stable Channel, multi-client message, Tool/Hook, Standalone Host, Subagent, and Abort Specifications carry the delivered contracts;
3. Current Architecture records the validated Session, Runner, Runtime, and Channel behavior;
4. [Validation](validation.md) records focused checks, full gates, and independent-review disposition;
5. this Change is archived as delivery provenance, while historical research and predecessor archives remain unchanged.

The project owner approved the full validation gate and authority transfer on 2026-09-18. No commit was created during closeout.

Follow [Development Workflow](../../../governance/development-workflow.md).