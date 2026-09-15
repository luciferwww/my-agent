# Slice 6 Documentation and Legacy Closeout Specification

> Status: Active — terminal validation complete; project-owner Slice acceptance remains open
> Date: 2026-09-14
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

Validation is complete in the historical Slice ledger, but Slice 6 remains open until explicit project-owner acceptance. The later clean-room documentation migration may replace physical successors and references; it does not retroactively change this historical gate.

## Validation gate

Acceptance requires exact manifest coverage, zero unsupported inbound references, source/test verification of retained Current facts, accepted successor ownership, Architecture Fitness, Markdown target/anchor checks, JSON validation, lint, clean build, full applicable tests on Node 22, integration scenarios, stale artifact/package scans, and independent review without unresolved Critical/High/Medium findings.

## Closeout

On explicit owner acceptance, record Slice completion and separately decide whether these active control artifacts become archived evidence or are discarded after unique-value review. Slice 6 completion alone does not supersede active Target Architecture or other Changes.
