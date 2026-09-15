# ADR-002: Context Budgeting and Compaction Recovery

> Status: Accepted
> Decision status: Accepted
> Decision date: 2026-09-01
> Owner: Project owner
> Authority: Durable decision
> Supersedes: A global context-window value as the fact for every model, Core inference of unknown model limits, and detached Compaction observers that cross lifecycle settlement

## Context

A model switch must not combine a new Provider/Model identity with a process-global context limit. Local estimation remains useful for avoiding predictable failures, but Provider metadata can become stale, a deployment can impose a smaller limit, and local token estimates can differ from Provider accounting. Provider-reported overflow is therefore the final correction signal.

Compaction must preserve Tool exchange integrity, make measurable progress, respect Abort, converge within bounded retries, and keep Provider, Runner, and Session ownership separate.

## Decision drivers

- Atomically switch Model identity and effective limits for each Parent or Child Turn.
- Keep Provider metadata, deployment limits, aliases, Catalogs, and errors inside Provider boundaries.
- Prevent Core from guessing limits from Provider or Model names.
- Combine predictive budgeting with Provider-observed correction.
- Keep conversation Compaction in Runner and authoritative persistence in Session.
- Bound observer settlement and recovery retries.

## Options considered

1. Retain one global context limit: simple but can bind new identity to stale facts.
2. Remove predictive budgeting: avoids stale estimates but pays for avoidable failures.
3. Use Provider-produced limits plus bounded overflow recovery: preserves ownership and predictive value.
4. Budget only known limits: honest but loses proactive protection for accepted models lacking facts.
5. Build a cross-Provider adaptive database in Core: duplicates Provider knowledge without sufficient evidence.

## Decision

Choose option 3.

### Provider-owned limits and Turn binding

Provider Integration interprets model facts. Model Resolution validates provenance and creates an immutable per-Turn Resolved Model. Effective context limits are positive Provider-produced facts with provenance; a Provider-owned fallback may fill a missing value but may not override a more specific applicable fact. Overflow observation can only tighten a limit.

A model switch atomically changes Provider binding, protocol, endpoint/deployment identity, capabilities, limits, and provenance. No cross-Provider default such as `200000` belongs to Stable Core.

### Budget and overflow authority

Predictive budgeting is an optimization, not final acceptance authority. Runner may prune eligible Tool Results or compact before invocation. A Provider Adapter normalizes recognizable overflow into the Core error contract and may provide a reported limit, conservative upper bound, or overflow-only signal.

Runner does not parse raw Provider errors or mutate the Turn-pinned Resolved Model. A correction tightens only the current Turn retry budget. Any observation retained for later Turns remains Provider-owned and isolated by Provider, endpoint/deployment, and Model identity.

### Compaction ownership

Runner owns prune/compact/retry/fail decisions, candidate construction and validation, Abort/deadline, and bounded no-progress recovery. Session owns authoritative history, Compaction records, metadata mutation, and atomic candidate commit. Provider does not compact conversations or write Session state.

Compaction is blocking within the Turn lifecycle. Runner must not retry Model invocation or settle the Turn until required Compaction work, the Session transition, and bounded observer settlement have completed.

A candidate is installable only when it is structurally valid, strictly smaller under the same estimator, fits the tightened retry budget when one exists, preserves atomic Tool exchange groups, and wins before Abort/deadline. A Session precondition failure or persistence failure does not create a successful Compaction.

`before_compaction` and `after_compaction` are observer-only. Hook Runtime classifies each observer as fulfilled, rejected, aborted, or timed out within the lifecycle boundary. Observer failure cannot transform the candidate or result, and late completion cannot mutate Session, events, or Turn outcome.

## Consequences

### Positive

- Model selection and effective limits remain internally consistent.
- Core is isolated from Provider catalogs and error formats.
- Predictive budgeting and overflow correction complement each other.
- Invalid or no-progress Compaction cannot silently install.
- Runner, Session, and Provider ownership is independently testable.

### Negative

- Every Provider must resolve facts and normalize overflow.
- Conservative fallback may compact early; optimistic fallback may incur one failed call.
- Candidate validation and bounded observer settlement add implementation responsibility.
- A misbehaving third-party observer may still produce external side effects after timeout, although it cannot alter the settled Turn.

## Deliberately unfrozen details

This ADR does not fix universal thresholds, reserve values, fallback values, Tool Result character limits, retained-Turn counts, deadlines, retry counts, summary prompts/schemas/models, event payloads, or persistence layout. Those belong to Provider policy and stable Specifications.

## Implemented boundary and evidence

Model Resolution now binds Provider facts and limits per Turn; Runner implements predictive budgeting, normalized overflow recovery, candidate progress checks, Tool-exchange preservation, Session-owned commit, and bounded observer settlement.

| Kind | Evidence |
|---|---|
| Current facts | [Model Resolution](../architecture/model-resolution.md), [Runner](../architecture/runner.md), [Session](../architecture/session.md), [Providers](../architecture/providers.md) |
| Stable contracts | [Model Resolution Specification](../specifications/model-resolution.md), [Runner Turn Flow Specification](../specifications/runner-turn-flow.md) |
| Foundation evidence | [AF-05 evidence](../evidence/spikes/af-05-provider-model-resolution.md), [AF-04 plan](../changes/archive/af-04-characterization-fitness/plan.md), [archived Target Architecture](../changes/archive/architecture-foundation/target-architecture.md) |
| Process | [Development Workflow](../governance/development-workflow.md) |
