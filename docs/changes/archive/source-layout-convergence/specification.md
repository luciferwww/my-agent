# Source Layout Convergence Migration Specification

> Status: Archived — C1 through C3 completed and owner-accepted
> Date: 2026-09-10
> Role: Migration scope and acceptance provenance; not Current Architecture

## Accepted scope

The change converged physical source ownership after the logical architecture Slices:

- Anthropic moved to the canonical Provider Adapter boundary.
- A required `builtin-anthropic-provider` Unit became the sole builtin Provider construction/registration seam.
- Runtime dependency construction returns a singular loaded Unit rather than naked Provider projection/concrete instances.
- Default selection occurs only from the successfully published Snapshot.
- Core Channel contracts moved to Core ownership; Adapter exports are concrete transports only.
- Turn Interaction moved to Runtime application ownership; old facade/alias paths were deleted.

## Delivery gates

C1 completed canonical Provider/Channel/interaction paths and removed old imports. C2 routed builtin Provider construction through common Unit staging and validated Parent/Child multi-Provider, empty Snapshot, required failure attribution, and candidate cleanup. C3 synchronized Current Architecture and Fitness evidence and passed focused/full validation plus independent review.

No compatibility facade, duplicate Provider construction path, old projection seam, direct pre-staging default read, or architecture Feature Flag remained. The superseded proposal had no unique retained authority and is discarded by the clean-room audit.

Current owners: [Providers](../../../architecture/providers.md), [Channels](../../../architecture/channels.md), [Runtime](../../../architecture/runtime.md), [Runtime Composition](../../../specifications/runtime-composition.md), and [ADR-005](../../../decisions/adr-005-extension-registry-runtime-composition.md).
