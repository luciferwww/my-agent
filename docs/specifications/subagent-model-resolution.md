# Subagent Model Resolution Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable Parent/Child resolution contract

## Scope

This contract defines real-Parent validation, Child identity/setup, Model Reference selection, independent Child Model Resolution, generation and Abort inheritance, terminal results/events, Usage preservation, and cleanup. Base profile/context behavior belongs to [Subagent](subagent.md).

## Model selection and delegation

```ts
type SubagentModelSelection =
  | 'inherit'
  | { readonly providerId?: string; readonly modelId: string };
```

User profiles explicitly provide `model`; built-in `general-purpose` explicitly uses `inherit`.

Delegation supplies profile, description, prompt, real Parent session/Turn/Tool-call identity, and Parent Abort signal. A Parent must be an active Runtime-managed Turn. `inherit` means the Parent's canonical effective Model Reference, not a global default and not the Parent Resolved Model object.

A concrete or inherited Child reference is independently resolved against the Parent's captured generation. Child receives a fresh Resolved Model, invocation Port, facts, limits, and request state. Requirements derive from the actual Child execution request. Resolution failure occurs before Provider invocation.

## Runtime ownership

Runtime validates Parent identity, allocates Child identity, registers route/tree membership, shares the tree Abort signal and Parent generation, emits lifecycle events, releases acquired resources, and returns one terminal result. Child does not recapture the latest generation.

Exactly one `subagent_start` and one correlated `subagent_end` exist for every accepted Child. A failure before acceptance emits neither. Cleanup releases only resources actually acquired; cleanup failure is diagnostic and does not rewrite the terminal outcome.

## Terminal contract

Resolution categories are `reference_invalid`, `provider_unregistered`, `connection_missing`, `connection_invalid`, `model_rejected`, `model_ambiguous`, `facts_insufficient`, `policy_denied`, `override_unauthorized`, `protocol_incompatible`, and `capability_unsupported`.

Terminal failure phases are setup, resolution with category, and execution. Abort remains a distinct terminal outcome. Usage accumulated by Runner is preserved exactly once across success, failure, Abort, or LLM-call limit.

## Lifecycle matrix

| Stage | Lifecycle events | Provider calls | Outcome |
|---|---:|---:|---|
| Parent validation fails | 0/0 | 0 | Parent Tool error, no Child |
| Identity/route setup fails | 1/1 | 0 | Setup failure and acquired cleanup |
| Session/prompt setup aborts | 1/1 | 0 | Aborted/setup failure |
| Model resolution fails | 1/1 | 0 | Resolution category, zero Usage |
| Runner completes/fails/aborts | 1/1 | 0..n | Normalized terminal result |
| Cleanup fails | no extra event | 0 | Preserve result; diagnose cleanup |

## Acceptance scenarios

Cover explicit inherit; fresh Child binding; concrete different Provider/Model; missing Parent; pre-invocation resolution failure; request-derived capabilities; stable Parent/Child bindings through Tool loops/Compaction; Abort during setup/resolution/execution; one terminal event; exact cleanup; Usage preservation; and zero Compatibility dependency.

## Related authority

[Model Resolution](model-resolution.md) owns shared resolution rules, [Runtime Composition](runtime-composition.md) owns generations, and [Abort](abort.md) owns tree cancellation.
