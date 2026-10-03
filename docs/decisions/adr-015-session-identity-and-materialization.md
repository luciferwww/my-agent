# ADR-015: Session Identity and Materialization

> Status: Accepted
> Decision date: 2026-09-18
> Owner: Project owner
> Related Plan/Specification: [Session Identity and Management Plan](../changes/archive/session-identity-and-management/plan.md), [Session Management Specification](../changes/archive/session-identity-and-management/session-management-specification.md)
> Supersedes: none

## Context

The current Session model uses a caller-provided `sessionKey` as the persistent index, Runtime concurrency and Abort key, Channel routing key, and public request identity. A separate generated `sessionId` identifies the Transcript file, while `sessionFile` duplicates a path that can be derived from that ID. This permits display labels and routing identity to collapse into one mutable-looking string and allows unknown caller input to create persistent state implicitly.

The target environment permits a clean cutover with an empty `<agentHome>/sessions/` directory. The Runtime remains single-process and already serializes Turns per Session. The approved research input is [New Session Model Design Draft](../research/session-model-design-draft.md); it is evidence for this proposal, not implementation authority.

## Decision drivers

- One immutable, system-issued identity for every persisted Session.
- Titles that can change or repeat without affecting routing or storage.
- No persistent empty Sessions created by abandoned UI flows.
- Deterministic first-send materialization without an external naming call.
- Explicit create, send, stop, archive, delete, and fork semantics.
- One production format after cutover, with no permanent compatibility branch.
- Clear ownership between persistence and application orchestration.

## Options considered

1. Retain caller-provided `sessionKey` as the public and persistent key. This minimizes edits but preserves identity/display coupling, typo-created resources, and duplicated identity fields.
2. Use a system-generated UUID as the canonical `sessionId` and keep title as metadata. This requires coordinated Store, Runtime, and protocol migration but establishes one stable identity.
3. Use a readable slug as the primary key. Rename, collision, escaping, and historical-reference rules would eventually require another internal identifier.

## Decision

Adopt option 2 with these durable boundaries:

1. `sessionId` is a server-generated UUID and the only Session identity in the Store, Transcript path, Session-scoped Runtime state, and public protocol.
2. `title` is optional, mutable, and non-unique. It never participates in identity, paths, routing, or authorization.
3. Session storage is scoped to one `agentHome`. Scope is not encoded in `sessionId` and no additional scope field is introduced in the first contract.
4. `createSession()` reserves an ID in a bounded in-process Pending Registry but does not create metadata or a Transcript. The first admitted `sendMessage()` materializes the Session metadata and Transcript root.
5. The Session Store is the visibility and commit authority. A Session is externally persistent only after its Transcript root and Store entry have both been written and the Store commit succeeds. Materialization derives title metadata from the admitted message but does not persist the message itself.
6. `SessionManager` owns persisted Session state. An application-layer Session service owns Pending registrations and coordinates first-send materialization with the Runtime's per-Session serialization boundary. The Runner remains the sole user-message writer.
7. Archive is part of the first persistent and API contract. UI exposure may be delivered later without changing the domain model.
8. Deleting a Session with fork descendants is rejected. No implicit cascade or orphaning is allowed in the first contract.
9. The cutover requires an empty `<agentHome>/sessions/` directory. The implementation does not read, migrate, or write the prior Store format and does not retain a dual-path compatibility layer.
10. This decision governs Session identity and lifecycle only. It does not redesign the internal models of Session consumers.
11. Prior Session status, usage-summary, and Compaction-summary metadata fields are not part of the new Store. Live status is Runtime-derived and existing Compaction records remain the source of Compaction history and statistics.

## Consequences

### Positive

- Rename and duplicate titles are safe.
- Misspelled or unauthorized IDs cannot silently create persistent resources.
- Abandoned creation flows do not pollute Session lists or storage.
- Runtime, Store, Transcript, and protocol references converge on one identity.
- The empty-directory prerequisite removes migration and compatibility complexity.

### Negative

- Store, Runtime maps, Channel protocols, and callers must migrate together.
- Pending IDs are process-local and are lost on restart.
- Materialization spans a Transcript and metadata Store, so failure recovery must be explicit rather than described as filesystem-atomic.
- Rollback after creating data in the new format requires removing that data or using a build that understands the new format.

## Validation

- Module contract tests prove ID immutability, duplicate-title support, Pending invisibility, first-message materialization, and unknown-ID rejection.
- Contract tests prove materialization does not persist message content and the Runner persists and supplies the first user message to its Turn exactly once after preflight.
- Fault-injection tests prove that failed materialization does not expose a Store entry and remains retryable while the Pending registration is live.
- Runtime tests prove same-Session serialization and different-Session concurrency after key migration.
- Protocol tests prove Session-scoped requests and events use `sessionId` only.
- Delivery requires the focused, integration, lint, and build checks listed in the related Specification.

## Migration and rollback

Cutover is allowed only when `<agentHome>/sessions/` is empty. No old Store reader, migration command, feature flag, fallback, or dual-write path is introduced.

Before first new-format data is written, rollback is a code rollback. Afterward, rollback requires first removing or relocating the new Session directory; an older build must not be pointed at the new Store.

## Follow-up

- Review and accept or amend the related Plan and Module Specification.
- Do not begin production implementation while this ADR remains `Proposed` or the Specification remains `Draft`.
- After validated delivery, transfer implemented facts to Current Architecture and the stable contract to `docs/specifications/`, then archive the Change.

Process authority: [Development Workflow](../governance/development-workflow.md).