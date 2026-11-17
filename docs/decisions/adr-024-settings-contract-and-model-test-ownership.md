# ADR-024: Settings Contract and Model Test Ownership

> Status: Accepted
> Decision date: 2026-11-11
> Proposal date: 2026-11-11
> Owner: Project owner
> Authority: Settings contract ownership and Runtime model Test resource ownership
> Supersedes: None

## Context

Channel currently defines the transport-neutral Settings capability that Runtime
implements and both Channels and embedding consume. SettingsManager also owns
model Test invocation and temporary resources alongside update transactions.
These are structural ownership concerns, not evidence of broken public behavior.

Moving contract ownership changes dependency direction and therefore requires an
ADR under the [Development Workflow](../governance/development-workflow.md).
The owner accepted this decision and authorized bounded implementation on
2026-11-11.

## Decision drivers

- One authoritative Settings contract independent of its transport consumers.
- One model Test resource owner, independently testable with Fakes.
- Unchanged Settings transactions, public exports and lifecycle semantics.
- No general section framework or unrelated structural cleanup.

## Options considered

1. Keep the existing structure. Lowest migration cost, but retains Channel-owned
   application contracts and coupled Test lifecycle responsibilities.
2. Extract only the Test lifecycle and the three Settings contracts. Establishes
   the two demonstrated boundaries with a bounded caller migration.
3. Introduce generic Settings providers or migrate all application capabilities.
   Requires abstractions and scope unsupported by current evidence; rejected.

## Decision

Select option 2:

- Core Settings owns SettingsCapability, SettingsActionRequest and
  SettingsActionResult. Channel consumes and composes that capability.
- Runtime continues to implement Settings. SettingsManager owns update
  transactions; its model Test module owns Test execution and temporary resources.
- The public Extension API remains the supported facade with unchanged exports.
- Preserve the existing Runtime Composition, Configuration, Channel and Agent
  Management contracts; introduce no new external behavior.

This refines module boundaries without superseding existing composition,
configuration, Channel or Agent-management behavioral contracts.

## Consequences

The change removes transport ownership from the Settings contract and makes Test
resource convergence independently verifiable. It adds a small contract module
and a private Runtime module, requiring caller/import and boundary-test updates.
If extraction creates broad callbacks or duplicate mutable owners, reduce or
revisit the design rather than adding a framework.

## Validation

Validate independent model Tests with Fakes, unchanged Settings integration,
generation protection, shutdown convergence, public exports and dependency direction.
Existing deterministic lifecycle tests provide the starting evidence; no new
external SDK behavior or concurrency policy is proposed, so no Spike is currently
required. Reassess if implementation reveals a contract-changing uncertainty.

## Migration and rollback

Migrate real callers and delete superseded definitions and execution code in the
same delivery. Retain the Extension facade; add no temporary compatibility path.
If an extraction fails validation before delivery, correct or withdraw that
extraction without leaving two production paths.

## Related authority

[Runtime Composition](../specifications/runtime-composition.md),
[Configuration](../specifications/configuration.md),
[Channel](../specifications/channel.md) and
[Agent Management](../specifications/agent-management.md) retain behavioral authority.
