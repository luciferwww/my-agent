# Slice 6 Documentation and Legacy Closeout Specification

> Status: Archived — project-owner accepted and completed
> Date: 2026-09-14
> Accepted: 2026-09-15
> Archived: 2026-09-15
> Owner: Project owner
> Governing decision: [ADR-006](../../../decisions/adr-006-legacy-and-compatibility-exit.md)

## Purpose

Slice 6 closes the earlier Architecture Foundation documentation and Legacy ledger. It establishes one Current Architecture, reviews 52 frozen document candidates, removes the deprecated Model Invocation facade, and validates the resulting authority surface. It does not replace the inventory ledger or authorize unrelated architecture work.

## Frozen scope and roles

The 52-document set contains 13 Current Fact candidates, 27 root/navigation/design candidates, and 12 historical version candidates. [Document disposition manifest](document-disposition-manifest.json) owns machine-readable states; [Legacy Migration Inventory](legacy-migration-inventory.md) owns cross-Slice code/API/Compatibility history. This Specification owns method and acceptance gates.

Authority priority is source/tests for actual behavior, accepted Decisions for durable choices, accepted stable contracts for behavior, active Plans/Target Architecture for unfinished design, and evidence for observations. File age or a `v1.0` directory does not determine authority.

## Disposition method

Each entry follows `Pending -> Migrating -> Migrated -> Reviewed -> Deleted` where deletion applies. Retention states must name the surviving authority role. Before deletion, review:

1. verified current fact;
2. durable decision;
3. unfinished approved work;
4. executed evidence;
5. stable historical locator value;
6. active inbound references and successor owner.

No entry is deleted merely because it appears old. Git is sufficient only for reconstructible process narration with no retained authority/evidence value.

## Terminal ledger state

- DOC-C01–C13: reviewed for Current Architecture retention/successor ownership.
- DOC-A08/A09: reviewed as active navigation/evidence summary.
- DOC-A04/A05: reviewed as strict non-authorizing deferred input.
- Remaining DOC-A and DOC-V entries: reviewed for deletion after migration.
- API-M04: removed as repository-internal breaking cleanup after caller/export/package audit.

Validation was completed in the historical Slice ledger, and the project owner accepted Slice 6 on 2026-09-15. The later clean-room documentation migration replaced physical successors and references without retroactively changing the historical disposition decisions.

## Validation gate

Acceptance required exact manifest coverage, zero unsupported inbound references, source/test verification of retained Current facts, accepted successor ownership, Architecture Fitness, Markdown target/anchor checks, JSON validation, lint, clean build, full applicable tests on Node 22, integration scenarios, stale artifact/package scans, and independent review without unresolved Critical/High/Medium findings. These gates passed before owner acceptance.

## Closeout

The project owner accepted Slice 6 on 2026-09-15. These control artifacts are archived as bounded historical evidence because they retain the 52-item disposition and cross-Slice Legacy closeout record. Slice 6 completion did not by itself supersede the then-active Target Architecture; the later Architecture Foundation closeout transferred that authority independently. Provider Catalog C4 was also accepted independently.
