# Extension Acquisition Source Layout Plan

> Status: Archived — B+ and B2 completed and owner-accepted
> Date: 2026-09-14
> Role: Refactoring provenance; not current source authority

B+ moved generic acquisition ownership from the concrete Extensions subtree to `src/extension-acquisition/` without changing contracts. B2 established the supported WebSocket Host/Core build root and verified that generic acquisition no longer depends on Relay implementation source.

## Accepted gates

- Generic acquisition source, tests, and public imports moved together.
- Concrete Extensions retained only implementation-specific code.
- Supported Host composition uses acquired `loadedUnits` plus builtin units without Relay-specific generic imports.
- Source-layout Fitness, package/build boundaries, focused and full Node 22 tests, lint, clean build, and independent review passed.

The stable contract is [Extension Acquisition](../../../specifications/extension-acquisition.md); [Extensions](../../../architecture/extensions.md) records current ownership.
