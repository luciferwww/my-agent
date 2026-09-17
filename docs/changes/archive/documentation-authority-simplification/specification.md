# Documentation Authority Simplification

> Status: Archived — C1-C3 and V1 completed; project-owner accepted
> Date: 2026-09-17
> Archived: 2026-09-17
> Owner: Project owner
> Type: Documentation architecture and workflow refinement

## Purpose

Reduce the documentation that a developer or coding agent must read and synchronize during ordinary work. Historical evidence remains available, but current work should begin from a small current-authority set and enter history only when the task requires provenance or migration analysis.

This Change refines content and navigation within the documentation structure established by the archived Documentation Reorganization. It does not introduce another documentation tree or workflow.

## Baseline

As of 2026-09-17:

| Surface | Files | Lines |
|---|---:|---:|
| Current Architecture | 17 | 1,587 |
| Stable Specifications | 16 | 620 |
| Accepted Decisions | 14 | 1,128 |
| Governance | 5 | 921 |
| Archive and Evidence | 43 | 4,203 |

The directory classification is sound. The observed cost comes from:

- current Architecture and Specifications repeating the same behavior;
- current pages linking delivery history into the default reading path;
- current authority retaining completed migration, removed-path, and revision narration;
- indexes, evidence tables, and Fitness manifests duplicating navigation metadata;
- ordinary local changes requiring synchronization across more authority surfaces than their behavior affects.

## Desired Reading Model

For ordinary implementation work, use this order:

1. source and focused tests for the observed behavior;
2. one owning Current Architecture topic for current boundaries and dependency direction;
3. one owning Stable Specification only when public behavior or lifecycle contracts matter;
4. one Accepted ADR only when rationale or a durable design constraint matters;
5. the current active Change when the work is part of an approved delivery.

`docs/changes/archive/`, `docs/evidence/`, `docs/research/`, superseded decisions, and Git history are opt-in sources. Read them only for provenance, prior alternatives, migration reconstruction, or unresolved authority transfer.

## Authority Rules

### Current Architecture

Own only verified current facts:

- module purpose and ownership;
- dependency direction;
- current runtime flow where needed to understand the boundary;
- links to the owning contract or decision.

Do not retain completed migration narration, delivery history, revision history, deleted path inventories, or repeated acceptance matrices. A negative statement remains only when it is a current architectural invariant that prevents a realistic regression.

### Stable Specifications

Own only current behavioral contracts:

- scope and public surface;
- invariants and lifecycle;
- failure semantics;
- acceptance scenarios.

Do not repeat module tours, implementation chronology, completed cutover instructions, old field/path inventories, validation results, or rollback procedures for a completed direct migration.

### Accepted ADRs

Own durable rationale:

- decision context;
- meaningful options and trade-offs;
- selected decision and lasting consequences;
- explicit supersession/refinement relationships.

ADRs are not default implementation reading. This Change does not rewrite accepted decisions merely to shorten them; only navigation metadata or clearly non-decision delivery narration may be considered in a separately reviewed batch.

### Active and Archived Changes

An active Change owns delivery scope, temporary implementation detail, and validation status. After closeout it moves to archive and leaves the default reading path. Archived Changes are immutable historical records except for necessary link repair caused by an approved authority move.

### Evidence and Indexes

Evidence proves an observation and is not default reading. Current indexes remain short navigation surfaces and do not reproduce architecture summaries. Machine-readable manifests may validate ownership, but should not require the same navigation facts to be manually maintained in multiple places.

## Scope

1. Add explicit default-reading and opt-in-history guidance to the documentation entry point and Development Workflow.
2. Audit only Current Architecture and Stable Specifications for historical narration and duplicated normative facts.
3. Assign each duplicated fact one prose owner; replace other copies with a short summary and link.
4. Remove archive/evidence links from ordinary topic flows, retaining optional provenance only where it answers a real rationale question.
5. Simplify indexes and FT-08/FT-12 metadata duplication where the same fact is manually maintained in more than one machine-readable or Markdown surface.
6. Validate the result using representative maintenance scenarios and existing documentation Fitness checks.

## Non-goals

- deleting or rewriting `docs/changes/archive/` or `docs/evidence/`;
- reorganizing the directory tree again;
- changing production architecture, behavior, APIs, or tests unrelated to documentation governance;
- deleting Accepted ADR rationale;
- replacing the Development Workflow or introducing another status model;
- enforcing prose duplication with a brittle line-count or text-similarity Gate;
- optimizing solely for the smallest total line count.

## Delivery Plan

### D1: Accept the authority and reading model

Confirm this Specification, including default exclusions, role boundaries, non-goals, and validation method. D1 authorizes audit and documentation edits only; it does not authorize production changes.

### D2: Build a current-authority audit

Classify each Current Architecture and Stable Specification page by:

- current facts/contracts retained;
- historical or migration narration removed;
- duplicated facts and selected owner;
- archive/evidence links removed from default flow;
- index/manifest duplication affected.

The audit is a temporary delivery aid and will be archived with this Change, not promoted to permanent governance.

### C1: Establish default navigation

Update the documentation entry point and Development Workflow with the accepted reading order and opt-in historical paths. Keep historical categories discoverable but explicitly non-default.

### C2: Simplify current prose owners

Edit Current Architecture first, then Stable Specifications. Process one bounded topic group at a time and run its link/Fitness checks before continuing.

### C3: Reduce inventory duplication

Review FT-08, FT-12, Architecture indexes, and evidence tables. Remove only duplication whose invariant is already enforced elsewhere or can be derived from one owner. Preserve durable module coverage and contract-coverage checks.

### V1: Validate and archive

Run focused documentation governance checks, link/path scans, Fitness tests, lint/build only where affected, `git diff --check`, and independent review. Record results and archive this Change.

## Validation Results

V1 completed on 2026-09-17:

- Architecture Fitness passed: 12 files, 38 tests;
- TypeScript lint passed for the root project and Relay workspace;
- documentation diagnostics and source/link checks passed;
- `git diff --check` passed with no output;
- independent review found no unresolved Critical, High, or Medium issue.

The project owner accepted closeout on 2026-09-17. Current authority now owns the delivered reading model and documentation boundaries; this Change and its audit remain only as delivery provenance.

## Acceptance Criteria

1. Default contributor guidance explicitly excludes archive/evidence/research from ordinary implementation lookup.
2. Current Architecture and Stable Specifications contain no completed delivery-history sections or normative links to archived Changes.
3. Representative facts for configuration, Runtime composition, Extension acquisition, and Channel lifecycle each have one normative prose owner.
4. A representative local implementation change requires updating at most its owning Architecture topic, its owning Specification when the contract changes, and validation for an active Change; ADR/history updates are not routine synchronization.
5. Current indexes navigate without duplicating detailed module behavior.
6. FT-08 and FT-12 retain durable coverage while avoiding duplicate manual ownership/navigation records where evidence supports removal.
7. Archived Changes and Evidence remain available and are not rewritten as part of simplification.
8. Existing authority precedence, source links, documentation diagnostics, Fitness tests, and `git diff --check` pass.
9. Independent review finds no unresolved Critical, High, or Medium issue.

## Decision Required

The project owner accepted D1 on 2026-09-17, authorizing D2 audit and documentation-only delivery in the listed phases. Any evidence requiring deletion of Accepted ADR content, a new repository instruction file, or weaker durable Fitness coverage must return for separate owner approval.