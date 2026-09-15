# Documentation Reorganization Proposal

> Status: Completed — D1/D2/C1/C2/C3/V1 accepted and validated
> Version: 0.3
> Date: 2026-09-14
> Authority: Completed documentation-migration record; not permanent architecture or workflow authority
> Scope: Define the information architecture and clean-room migration controls for reorganizing mixed legacy, transitional, current, and refactoring documentation

The project owner accepted D1 on 2026-09-14 after independent design review returned PASS with no unresolved Critical/High/Medium blocker and focused documentation governance checks passed 18/18. The complete 72-entry D2 audit was accepted, C1 established the isolated clean-room boundary, and all C2 successor surfaces were ported and independently reviewed. C3/V1 then switched active references and authority metadata, replaced migration-only Fitness, removed the temporary old tree, and passed focused/full validation. Merge, release, commit, and push remain separate actions.

## 1. Background

The current documentation tree mixes several generations and roles in the same searchable space:

1. old-version documents that no longer describe the refactored system;
2. transitional or compatibility documents that contain some valid contracts but retain old structure and terminology;
3. Current Architecture documents describing implemented facts;
4. accepted ADRs and long-lived contracts;
5. completed Plans, Proposals, Migration Specs, Spike Specs, and Results;
6. active refactoring documents;
7. deferred design inputs and non-authoritative research.

Even when individual files declare a status, readers and coding agents must inspect many documents to determine which statement is authoritative. Old files that remain under the normal `docs/` tree also continue to look maintainable: later work can accidentally discover, cite, or synchronize them even after a successor exists. The goal is therefore not merely to rename files, but to physically separate current facts, durable decisions, stable contracts, active changes, evidence, deferred inputs, and non-authoritative research while making exclusion—not retention—the default for obsolete material.

## 2. Objectives

The reorganization should make the following questions easy to answer:

| Question | Canonical location |
|---|---|
| How does the system work now? | `docs/architecture/` |
| Why was a durable design decision made? | `docs/decisions/` |
| What contract must implementations satisfy? | `docs/specifications/` |
| How does the project plan, implement, and review work? | `docs/governance/` |
| What change is currently being designed or delivered? | `docs/changes/active/` using the existing Plan/Spec workflow |
| What executed evidence is worth retaining? | `docs/evidence/` |
| What explicitly deferred option is not authorized? | `docs/deferred/` |
| Where is non-authoritative external research? | `docs/research/` |

The migration should also:

- establish one authority owner for each fact or contract;
- remove obsolete process narration from active documentation;
- use reader-oriented filenames rather than historical source-directory prefixes;
- retain only material with verified current, contractual, decision, operational, or research value;
- make old documents ineligible for the new tree unless their retained value is explicitly ported;
- avoid a permanent `legacy/` or `docs_old/` dumping ground;
- simplify document-related Architecture Fitness after the migration completes.

## 3. Organizing principles

1. **Authority is semantic, not chronological.** An older accepted ADR may remain authoritative; a newer proposal may still be non-authoritative.
2. **One fact, one owner.** Current facts, durable decisions, contracts, unfinished work, and executed evidence must not compete across multiple documents.
3. **Current Architecture describes only implemented facts.** Target behavior and unfinished work must not appear as current behavior.
4. **Completed is not current.** A completed Plan or Spike proves that work occurred but does not own current implementation facts.
5. **Deferred is not active.** Deferred inputs must be visibly non-authorizing and separate from active Plans and Specifications.
6. **Navigation stays thin.** Index files link and summarize; they do not duplicate detailed architecture.
7. **Git preserves discarded process history.** Obsolete implementation narration does not need to remain in the active tree.
8. **No dual change authority.** The existing Development Workflow remains the only change workflow; this migration does not introduce OpenSpec or a second state model.
9. **Module-oriented current documentation.** Current Architecture topics should align with meaningful system modules rather than old physical prefixes.
10. **Clean-room inclusion is explicit.** A document enters the new tree only when its current, contractual, decision, change, evidence, deferred, governance, or research value is reviewed and assigned a new owner.
11. **The old tree is read-only evidence.** During migration, `docs_old/` is a temporary, non-authoritative input: it is never updated, linked from new authority, merged, released, or retained after final acceptance.

## 4. Proposed target structure

```text
docs/
├── README.md
│
├── governance/
│   ├── README.md
│   ├── development-workflow.md
│   ├── architecture-principles.md
│   ├── domain-glossary.md
│   └── coding-standards.md
│
├── architecture/
│   ├── README.md
│   ├── overview.md
│   ├── runtime.md
│   ├── runner.md
│   ├── model-resolution.md
│   ├── providers.md
│   ├── extensions.md
│   ├── channels.md
│   ├── tools.md
│   ├── builtin-tools.md
│   ├── media.md
│   ├── session.md
│   ├── prompt.md
│   ├── memory.md
│   ├── workspace.md
│   ├── configuration.md
│   └── observability.md
│
├── decisions/
│   ├── README.md
│   └── adr-*.md
│
├── specifications/
│   ├── README.md
│   └── <active-long-lived-contract>.md
│
├── changes/
│   ├── README.md
│   ├── active/
│   │   └── <change-name>/
│   │       ├── plan.md
│   │       ├── specification.md
│   │       └── validation.md
│   └── archive/
│       └── <completed-change-name>/
│
├── evidence/
│   ├── README.md
│   └── spikes/
│       └── ...
│
├── deferred/
│   ├── README.md
│   └── ...
│
├── research/
│   ├── README.md
│   └── ...
│
└── templates/
    └── ...
```

This proposal does not adopt OpenSpec. `docs/changes/` is a physical organization for the repository's existing Plan, Module Spec, Spike, validation, owner-acceptance, and status model; it does not define a second workflow. Each active change has one scope/task authority under the current Development Workflow.

## 5. Authority model

### 5.1 Governance

`docs/governance/` defines how work is classified, designed, approved, validated, and completed. It should contain only durable project-wide rules.

Candidate inputs:

- current Development Workflow;
- Architecture Principles;
- Domain Glossary;
- Coding Standards.

Migration ledgers and one-time closeout records should not automatically become permanent governance documents.

### 5.2 Current Architecture

`docs/architecture/` should itself be the current architecture authority. A second `current/` level is unnecessary after the old mixed architecture directory has been removed.

Recommended reader-oriented renames include:

| Current topic name | Proposed name |
|---|---|
| `current/core_runner.md` | `architecture/runner.md` |
| `current/core_model_resolution.md` | `architecture/model-resolution.md` |
| `current/adapter_llm.md` | `architecture/providers.md` |
| `current/adapter_channel.md` | `architecture/channels.md` |
| `current/platform_config.md` | `architecture/configuration.md` |
| `current/platform_logger.md` | `architecture/observability.md` |

The historical prefixes `core_`, `adapter_`, and `platform_` should not determine reader-facing document names.

### 5.3 Decisions

Accepted ADRs should move to `docs/decisions/` and remain independent documents. They explain durable choices affecting multiple changes and must not be merged into current facts or transient designs.

### 5.4 Specifications

`docs/specifications/` should contain only contracts that remain useful after delivery. A stable Specification should focus on:

1. scope;
2. public contract;
3. invariants;
4. lifecycle and ownership;
5. errors and failure semantics;
6. acceptance scenarios;
7. implementation evidence or controlling decisions.

The following should normally be removed from the stable Specification or retained only in an archived Change:

- implementation batches;
- repeated authorization history;
- obsolete path migration instructions;
- temporary compatibility counts;
- per-review narration;
- one-time rollback procedures.

### 5.5 Changes

A change should own its Plan, design/Specification, implementation scope, and verification status in one place. `docs/changes/` groups those existing artifacts without replacing their individual authority roles or status transitions.

```text
docs/changes/active/<change-name>/
├── plan.md
├── specification.md
└── validation.md
```

Completed changes may move to `docs/changes/archive/` only after unfinished work, durable contracts, deferred successors, and evidence ownership are reviewed. Current Architecture and stable Specifications are synchronized during closeout; archived change documents do not become current authority.

### 5.6 Evidence

`docs/evidence/` retains executed internal evidence that remains useful after a change, such as accepted Spike Results or bounded validation records that support a durable decision. Evidence proves what was observed; it does not become Current Architecture, a stable contract, or external research.

### 5.7 Deferred inputs

`docs/deferred/` contains explicitly non-authorizing alternatives with an owner, freeze, activation condition, and required future successor. A deferred file is not an active Plan or Specification and must not be treated as implementation guidance.

### 5.8 Research

External comparisons and exploratory analysis belong in `docs/research/`. A local README must state that research is non-authoritative and cannot override accepted decisions, stable contracts, source, or tests.

## 6. Recommended split and merge decisions

### 6.1 Align reader topics without collapsing authority

- Split Extension acquisition from Configuration, grounded in the completed B+ source boundary: `architecture/configuration.md` owns workspace/agent configuration and Wizard facts, while `architecture/extensions.md` owns Agent Home, discovery, scoped Extension configuration, entry contracts, and acquisition. Runtime continues to own Unit lifecycle and publication. The split occurs in the Current Architecture port batch with source/test evidence and the FT-12 successor ownership update, not as an earlier standalone rename.
- Keep `architecture/tools.md` and `architecture/builtin-tools.md` as separate owners, with cross-links between the canonical Tool contract/policy boundary and concrete builtin capability inventory.
- Keep provider-neutral Model Invocation/Resolution responsibilities distinct from concrete Provider integration inside the reader-facing architecture map; use links and an overview flow rather than merging authority.
- Extract still-valid configuration contracts from older restructuring documents into current Architecture and, only where a long-lived implementation contract remains necessary, a stable Configuration Specification.

### 6.2 Keep separate where lifecycle differs

Do not merge:

- Runtime and Runner;
- Model Resolution and Provider integration;
- Session and Memory;
- Channel transport and Runtime orchestration;
- Prompt and Workspace;
- Configuration and Extension Framework;
- canonical Tool contract/policy and concrete Builtin Tool behavior;
- provider-neutral invocation/resolution and concrete Provider protocol integration;
- Current Architecture and Target/active design.

### 6.3 Partially superseded documents

Partially superseded documents must not be moved intact. Their sections should be classified individually:

| Content | Destination |
|---|---|
| Verified current behavior | Current Architecture |
| Long-lived public contract | Stable Specification |
| Durable design choice | ADR |
| Unfinished approved work | Active Change |
| Deferred alternative | Explicit Deferred Change or delete after review |
| Completed implementation narration | Git history or Change archive |
| Obsolete assumptions and paths | Delete |

The existing Subagent proposal/spec family is a priority candidate for this treatment.

## 7. Initial disposition guidance

### Move with minimal semantic change

- Development Workflow, Architecture Principles, Domain Glossary, and Coding Standards → `governance/`;
- accepted ADRs → `decisions/`;
- Current Architecture topics → the new `architecture/` root with reader-oriented names;
- research/analysis documents → `research/`;
- templates → retain under `templates/`.

### Extract, consolidate, then delete the originals

- completed Migration Specs and source-layout Proposals;
- completed Delivery Plans;
- Slice-specific closeout Specs and detailed disposition ledgers;
- partially superseded Subagent Specifications;
- old configuration restructuring documents;
- completed implementation amendments whose lasting contract belongs in a stable Specification or ADR.

### Do not migrate unless unique value is demonstrated

- old-version design narratives;
- per-batch approval logs;
- obsolete path tables;
- transient compatibility instructions;
- repeated verification command output;
- completed task checklists already reconstructible from Git and tests;
- `CLAUDE.md` content already incorporated into the authoritative Development Workflow.

### Retain but isolate

- executed Spike Results with durable evidence;
- external comparative research;
- explicitly deferred design alternatives with an owner and successor condition.

The clean-room rule is asymmetric: omission from the new tree is the default, but deletion is not automatic. Every old file must be reviewed for unique current, contractual, decision, unfinished-work, evidence, deferred, governance, or research value before `docs_old/` can be removed.

## 8. Documentation index design

The new `docs/README.md` should remain short and answer seven questions:

1. **How does the system work now?** → Architecture
2. **Why was it designed this way?** → Decisions
3. **What contracts must implementations satisfy?** → Specifications
4. **What is changing now?** → Changes under the existing Development Workflow
5. **How is work performed and reviewed?** → Governance
6. **What evidence or deferred options are retained?** → Evidence / Deferred
7. **Where is external research?** → Research

Each category should have its own README containing a compact table with document, status, owner, purpose, and successor where applicable.

## 9. Migration method

The migration should be treated as an independent documentation architecture change. It must not be combined with unrelated production refactoring.

### Phase D1 — Approve information architecture

Before moving files, confirm:

- target directories;
- authority precedence;
- filename conventions;
- continued use of the existing Development Workflow for Changes;
- stable Specification criteria;
- Evidence and Deferred retention criteria;
- final acceptance and deletion conditions.

D1 approves only the target information architecture, authority rules, migration controls, and source-set policy. It does not authorize the D2 file audit, creation of `docs_old/`, content porting, deletion, or Fitness changes. The migration source set is limited to documentation tracked at the accepted D1 baseline plus untracked inputs that the project owner explicitly adds. Incidental untracked files are out of scope by default; in particular, `docs/CLAUDE.md` is not included unless the project owner separately authorizes its review.

### Phase D2 — Build a per-file port audit

After separate D2 authorization, start from the complete owner-approved source set: tracked documentation at the accepted D1 baseline plus only explicitly included untracked inputs. Reuse the existing Slice 6 disposition manifest and Legacy Migration Inventory as evidence rather than rebuilding their historical analysis, and account for tracked documents created after that historical baseline. Every in-scope old file must receive exactly one primary port outcome:

- `Port as Current Architecture`;
- `Port as Governance`;
- `Port as Decision`;
- `Port as Stable Specification`;
- `Port as Active or Archived Change`;
- `Port as Evidence`;
- `Port as Deferred`;
- `Port as Research`;
- `Discard after Review`.

Example:

| Old document | Unique retained value | Port outcome | New owner(s) | Deletion condition |
|---|---|---|---|---|
| Current module topic | Verified implemented facts | Port as Current Architecture | Reader-oriented Architecture topic | New topic verified against source/tests |
| Completed Migration Spec | Lasting invariants plus reconstructible narration | Port contract/evidence, discard narration | Specification and/or Evidence | Invariants migrated, links updated, narration reconstructible |
| Accepted ADR | Durable decision | Port as Decision | Decisions | Content and all inbound links updated |
| Obsolete Proposal | None after source/test/authority review | Discard after Review | None | Zero active inbound links and no unique value |

The audit is a migration control surface, not permanent architecture authority. Its minimum fields are `source`, `role`, `uniqueValue`, `portOutcome`, `targets`, `excludedContent`, `verification`, `status`, and `deletionGate`. No physical migration should start before the file set is complete and the initial outcomes are accepted.

### Phase C1 — Create the clean-room migration boundary

In a dedicated migration branch or worktree:

1. rename the current `docs/` to `docs_old/`;
2. create the new `docs/` skeleton;
3. treat `docs_old/` as read-only, non-authoritative evidence input;
4. prohibit edits within `docs_old/` and prohibit links from new documents or source code to it;
5. port reviewed content into new owners rather than copying old files intact;
6. do not merge, release, or present the intermediate dual-tree state as a checkpoint of the target branch.

The migration may be developed in local or non-mergeable construction checkpoints. Final delivery must atomically contain the complete new `docs/` tree and no `docs_old/` directory. If remote backup is required, use a clearly non-mergeable migration branch and deliver through a clean squash or selected final commits.

### Phase C2 — Migrate in authority order

Recommended order:

1. Governance;
2. Current Architecture;
3. ADRs;
4. stable Specifications;
5. active Changes;
6. Evidence;
7. Deferred inputs;
8. Research;
9. Templates.

For each topic, migrate content rather than blindly copying files.

### Phase C3 — Switch repository references

Update together:

- root README and documentation indexes;
- source comments and code-facing document references;
- Markdown links and anchors;
- package scripts where applicable;
- Architecture Fitness rules;
- JSON manifests and inventories;
- active Plan/Specification links that remain during migration.

### Phase C4 — Remove temporary and obsolete material

After all port outcomes are verified:

- require `Pending = 0` and every old file to be either `Ported + Reviewed` or `Discarded + Reviewed`;
- delete `docs_old/` atomically with the final reference switch;
- delete superseded Proposals, Plans, Migration Specs, and temporary ledgers that have no unique retained value;
- remove migration-only manifests and Fitness assertions;
- confirm that no repository text references old paths.

### Phase V1 — Validate the final authority surface

The final validation should include:

- Markdown target and anchor audit;
- one current owner per module;
- no target/deferred claims presented as current facts;
- no `docs_old` path or reference;
- Architecture Fitness updated for the new permanent structure;
- deletion or simplification of migration-only Fitness rules;
- TypeScript lint and clean build where document paths are compiled or scanned;
- full relevant test suite;
- `git diff --check`;
- review that no unrelated working-tree changes were included.

## 10. Architecture Fitness after migration

The permanent Fitness layer should enforce only durable invariants, such as:

- one Current Architecture overview;
- one topic owner per current module;
- valid source/test/decision evidence links;
- explicit authority and lifecycle metadata;
- no active references to deleted or deferred documents;
- no old canonical source or documentation paths.

One-time Slice 6 disposition states, exact historical file counts, the clean-room port audit, and migration-specific path assertions should be archived or reduced only after permanent Fitness proves complete ownership and link/path closure. Fitness must protect the target information architecture, not preserve migration machinery indefinitely.

## 11. Risks and anti-patterns

- Renaming the tree before the complete file-set baseline and port-audit schema are accepted;
- copying all old documents into new categories without content review;
- editing or linking into `docs_old/` after the clean-room boundary is established;
- merging or releasing the intermediate `docs_old/` plus new `docs/` dual tree;
- retaining `docs_old/` or creating a permanent `legacy/` dumping ground;
- adding a second workflow or state model alongside the existing Development Workflow;
- merging Runtime with Runner or Model Resolution with Provider integration;
- moving partially superseded Specifications intact;
- treating completed Plans or Results as Current Architecture;
- deleting accepted ADRs merely because implementation is complete;
- changing document paths without updating source comments, manifests, and Fitness;
- mixing this migration with unrelated production behavior changes;
- preserving migration process logs in stable Specifications.

## 12. Candidate acceptance conditions

1. The target structure and authority precedence are explicitly accepted.
2. Every old document has one reviewed terminal port outcome and destination or discard reason; no item remains `Pending`.
3. Current Architecture contains only verified implemented facts.
4. Every current system module has one topic owner.
5. Durable decisions remain discoverable through ADRs.
6. Stable Specifications contain contracts rather than implementation chronology.
7. Each active change has exactly one scope/task authority under the existing Development Workflow.
8. Evidence, Deferred, and Research have separate roles and cannot present themselves as Current Architecture or active implementation authority.
9. `docs_old/` is absent from the final tree and has zero repository references.
10. Obsolete and migration-only documents are deleted after their retained content is verified elsewhere.
11. Permanent Fitness validates the new structure without preserving obsolete migration states.
12. Link, anchor, Fitness, lint, build, test, and diff checks pass.

## 13. Recommendation

Proceed with documentation reorganization, but treat it as a content and authority migration rather than a bulk file move.

The recommended long-term model is:

```text
docs/governance/       how the project works
docs/architecture/     how the implemented system works now
docs/decisions/        why durable choices were made
docs/specifications/   what stable contracts require
docs/changes/          what is active or archived under the existing workflow
docs/evidence/         what durable internal execution evidence was observed
docs/deferred/         what is explicitly frozen and not authorized
docs/research/         non-authoritative inputs
```

The immediate next step after D1 acceptance is Phase D2: create and review the complete per-file port audit. No file moves, deletions, `docs_old/` creation, or Fitness rewrites are authorized by this Discussion Draft.
