# Channel Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-15
> Authority: Stable Channel contract

## Scope

This contract defines Channel contribution, instance, Runtime binding, lifecycle, completion, transport ingress, Fanout, and interaction capability. Builtin and External Channels use the same Unit staging and publication path.

## Core contracts

```ts
interface ChannelInstance {
  readonly id: string;
  readonly completion: Promise<ChannelCompletion>;
  send(event: AgentEvent): void | Promise<void>;
  onMessage(handler: (request: ChannelRunRequest) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly interaction?: ChannelInteractionTransport;
  bindRuntimeCapabilities?(capabilities: ChannelRuntimeCapabilities): void;
}

type ChannelCompletion =
  | { outcome: 'closed'; reason: 'input_closed'|'transport_closed'|'stopped' }
  | { outcome: 'failed'; phase: 'startup'|'runtime'|'shutdown'; error: Error };
```

A `ChannelContribution` creates one instance per generation. Publication exposes immutable narrow bindings with `id`, `send`, and optional interaction capability; it never exposes the factory, concrete instance, or stop authority.

`ChannelRunRequest` carries session key, text or structured blocks, optional `modelReference`, optional `requestOverride`, optional LLM-call limit, and optional client ID.

## Lifecycle invariants

- Registration stages metadata only; it does not call `create()` or `start()`.
- Contribution, instance, and Runtime-visible IDs must match.
- `completion` exists before `start()` and settles once.
- `start()` resolves only after transport readiness; completion before readiness is startup failure.
- Create/start/pre-handoff failure rolls back all created siblings in the same Unit once; independent Units remain isolated.
- Cross-kind Unit contributions publish atomically.
- Only successfully handed-off instances enter a generation.
- After handoff, the lifecycle owner controls stop; RuntimeApp holds narrow bindings only.
- Natural close, runtime failure, and stop use first-terminal-wins semantics; Runtime does not restart a completed Channel.
- A root Turn keeps its captured generation's Channel bindings.
- Zero-Channel startup is valid and interaction fails closed.
- Shutdown settles pending approvals before Channel stop and reports stop failure under `channel:<id>`.

## Routing and Fanout

Runtime owns session queueing, origin routes, Abort, and target selection. Channel owns transport framing, connected-client audience, and presentation. Fanout failure is isolated per Channel/client and cannot change Runner outcome or sibling delivery.

Model Catalog query and Abort are narrow Runtime capabilities; Channel does not own model facts or lifecycle state.

When Runtime reports `provider_unregistered` or `model_rejected`, Channel presentation preserves the classified failure. A catalog-capable interactive client refreshes the current Catalog for explicit reselection; it does not substitute a Provider/Model or resubmit the failed Turn. Other resolution and invocation failures remain ordinary reported failures and retain the user's selection for an explicit retry.

## Failure semantics

Create failure means no instance. Start rejection or pre-readiness completion is `failed/startup`. Unexpected post-handoff transport failure is `failed/runtime` and does not mutate the published Snapshot. Runtime Composition observes each successfully published Channel completion once and records failed outcomes with bounded Channel ID/phase fields rather than raw Error content. A rejected completion Promise is normalized at the Runtime boundary to `failed/runtime`; it does not reject Host or embedded-caller completion observation. Concrete Hosts do not duplicate that failure log. Explicit stop produces `closed/stopped` unless another terminal result won; stop rejection is `failed/shutdown`. Cleanup errors do not erase the root failure.

There is no Channel-specific wall-clock timeout. Bounded aggregate deadlines belong to Runtime Composition.

## Acceptance scenarios

Cover identical Builtin/External staging; invalid/duplicate IDs; staging without creation; mixed contribution atomicity; immutable narrow projections; readiness vs completion; create/start rollback; zero-Channel readiness; close-once; sibling failure isolation; completion-before-readiness; post-start failure; origin-bound approval; Fanout isolation; and no direct script-owned Channel lifecycle.

## Related authority

[Channels](../architecture/channels.md) owns current facts and [ADR-014](../decisions/adr-014-extension-packages-and-runtime-composition.md) owns the composition decision. Related contracts: [Approval Lifecycle](approval-lifecycle.md), [Attachments](attachments-support.md), and [Multi-client User Messages](multi-client-user-messages.md).
