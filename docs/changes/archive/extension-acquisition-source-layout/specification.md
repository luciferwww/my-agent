# Extension Acquisition Source Layout Refactoring Specification

> Status: Archived — implemented and owner-accepted
> Role: B+/B2 scope and acceptance provenance

## Frozen scope

The refactoring changed source ownership only: generic Host acquisition moved to `src/extension-acquisition/`; concrete optional implementations remain under `src/extensions/`. Runtime continues to own Unit creation, staging, publication, retirement, and stop. Public behavior, Descriptor/config contracts, and acquisition result shape were preserved.

B2 made the supported WebSocket Host a separately buildable composition root using the generic acquisition boundary. It did not turn the Host build into a universal installer, package manager, or self-contained third-party deployment artifact.

## Acceptance constraints

- No generic acquisition import from a concrete Extension.
- No Relay-specific branch in generic loader or Runtime.
- Existing callers/tests migrate atomically; no compatibility facade or duplicate source root remains.
- Build/Fitness asserts ownership and emitted-host dependency closure.
- Full behavior regression proves source relocation did not change acquisition semantics.

Current contract: [Extension Acquisition](../../../specifications/extension-acquisition.md). Current facts: [Extensions](../../../architecture/extensions.md).
