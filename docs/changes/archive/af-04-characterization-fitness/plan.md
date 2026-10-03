# AF-04 Characterization and Fitness Plan

> Status: Archived — completed and owner-accepted
> Role: Historical validation provenance; not current behavior authority

AF-04 froze behavioral characterization and architecture Fitness before production migration. It mapped runtime/runner/tool/session/channel/config/Provider behaviors to executable evidence and introduced dependency, ownership, deletion, and documentation-governance checks used by later Slices.

## Retained value

- characterization-before-refactor discipline;
- explicit evidence mapping rather than intuition-based migration;
- expected-failure Fitness evolution under accepted target boundaries;
- validation gates requiring focused tests, full applicable regression, lint/build, and independent review;
- provenance for [ADR-001](../../../decisions/adr-001-tool-result-closure-and-recovery.md) and [ADR-002](../../../decisions/adr-002-context-budgeting-and-compaction-recovery.md).

Current facts now belong to [Current Architecture](../../../architecture/README.md), source, and tests. This archive does not keep obsolete command output or old paths authoritative.
