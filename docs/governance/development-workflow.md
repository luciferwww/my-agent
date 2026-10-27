# Development Workflow

## 1. Document Status

- **Status:** Accepted
- **Version:** 1.4
- **Date:** 2026-09-17
- **Owner:** Project owner
- **Scope:** Code, tests, architecture, documentation, and experimental changes in my-agent

This document is the single source of truth for the development workflow. `CONTRIBUTING.md` only provides the contribution entry point, and templates only define artifact structure. In the event of a conflict, this document and `Accepted` ADRs and Specs take precedence.

## 2. Core Principles

1. Classify the work before deciding whether a Plan, Spec, ADR, or Spike is required.
2. Confirm the scope before making changes; do not expand objectives or change the architecture without approval.
3. Use architecture documents as the design basis during implementation. If code evidence disproves the design, pause and revisit the decision.
4. Immediately after the first substantive change, run the smallest focused check capable of falsifying the hypothesis.
5. Fix root causes, keep changes local, and do not refactor unrelated code along the way.
6. Verify and classify reviewer feedback before deciding whether to accept it, accept it with modifications, or reject it.
7. Promptly remove superseded paths once the new authoritative path is established. Compatibility must have an expiration date.
8. Documentation, tests, and implementation together provide evidence of completion.
9. Investigate local uncertainties independently when code, tests, runtime evidence, or authoritative documentation can resolve them. Do not interrupt work for routine factual questions.
10. Every substantive change must be traceable to a confirmed requirement, acceptance criterion, defect evidence, or necessary cleanup directly resulting from the current change. Do not introduce abstractions, configuration, or runtime paths that are not justified by current evidence.

## 3. Work Classification

| Type | When to Use | Minimum Artifacts | Approval Requirements |
|---|---|---|---|
| Small Change | Local, low-risk maintenance that preserves behavioral boundaries | Clear requirement or Issue | Scope confirmation |
| Defect | Existing behavior deviates from a confirmed contract or expectation | Reproduction evidence and regression tests | Confirmation of the fix scope |
| Documentation | Documentation corrections that do not change production behavior | Description of the documentation change | Owner confirmation when authoritative facts change |
| Architecture Slice | Changes to module boundaries, dependency direction, public contracts, or authoritative production paths | Plan Item + Accepted ADR/Spec | Project owner approval to enter Delivery |
| Architecture Spike | Critical unknowns that cannot be resolved through static analysis or small tests | Accepted Spike Spec | Project owner approval of the experiment |

Work classification is not determined by the number of changed lines. A small public contract change may still be an Architecture Slice, while a large set of mechanical documentation corrections may only be Documentation.

## 4. Artifact Selection

### Plan

Use a Plan for cross-phase objectives, sequencing, Gates, risks, and exit criteria. An `Accepted` Plan authorizes execution; it does not mean implementation is complete or that any Gate has passed.

### ADR

An ADR is required when any of the following applies:

- The decision has long-term implications and is difficult to reverse.
- It changes dependency direction, the authoritative source of facts, or public architectural boundaries.
- Multiple viable options involve significant trade-offs.
- It supersedes an `Accepted` architecture decision.

### Module Spec

A Module Spec is required for changes to public APIs, Events, concurrency, lifecycle, error semantics, resource ownership, or cross-module contracts.

### Spike

Run a Spike first when unknowns in any of the following areas could affect architectural conclusions:

- External SDKs, Provider Metadata, or protocol behavior.
- Concurrency, cancellation, draining, shutdown, or resource release.
- Extension boundaries that cannot be validated through design alone.
- Assumptions whose failure would force changes to the architecture or migration sequence.

Spike code is disposable by default. Record conclusions in Spike Results; only evidence-backed conclusions may be incorporated into an ADR or Spec.

## 5. States and Responsibilities

| Artifact | State Flow | Approver |
|---|---|---|
| Plan | `Proposed -> Accepted -> Superseded | Cancelled` | Project owner |
| Plan Item | `Not Started -> In Progress -> In Review -> Completed` | Project owner confirms completion |
| ADR | `Proposed -> Accepted -> Superseded` | Project owner |
| Module Spec | `Draft -> In Review -> Accepted -> Implemented -> Validated` | Project owner accepts the design and validation results |
| Spike | `Draft -> Accepted -> Executing -> Provisional Pass | Failed -> Completed` | Project owner approves execution and confirms Results |

Plan Items may also use `Blocked`, `Deferred`, and `Cancelled`. ADRs may also use `Rejected` and `Deprecated`. Record each state in the corresponding artifact; preserve review conclusions and approvals through documentation changes and Git history.

## 6. Definition of Ready

Small Change and Documentation work only require a clear scope, sources of facts, and a validation approach. Before implementation begins, an Architecture Slice must satisfy the following:

- [ ] The associated Plan Item and user-observable outcomes are clear.
- [ ] Non-goals and change boundaries are clear.
- [ ] Associated ADRs and Specs are `Accepted`.
- [ ] Spikes addressing unknowns in external SDKs, Metadata, lifecycle, or concurrency are complete.
- [ ] Module ownership and dependency direction are clear.
- [ ] Compatibility, Feature Flags, and conditions for removing old paths are clear.
- [ ] The scope of focused tests, contract tests, and broader validation is clear.
- [ ] No unresolved Blocker could invalidate the conclusions.

An Architecture Slice that is not Ready must not enter Delivery. Do not work around unknowns by adding special cases to old paths.

## 7. Implementation Workflow

1. **Establish the facts:** Start with failing behavior, tests, target files, or authoritative documentation, and form a falsifiable local hypothesis. Independently investigate uncertainties that existing evidence can resolve; do not refer directly verifiable factual questions to the project owner for a decision.
2. **Confirm scope and decision boundaries:** Describe the intended changes, non-goals, and minimum validation. For multi-step work, briefly list objectives, validation methods, and exit criteria. If new evidence would change accepted public behavior, architectural boundaries, ownership of facts, dependency direction, or Compatibility policy; require an undocumented/private dependency; introduce multiple production runtime paths; or materially increase complexity and maintenance scope, list the evidence, impact, and options, and pause the affected changes until confirmation is obtained.
3. **Make the first small change:** Test the hypothesis with the smallest reversible change that follows existing patterns.
4. **Run focused validation immediately:** After the first substantive change, run the cheapest behavioral test, relevant tests, or type check before expanding the scope.
5. **Iterate locally:** If validation fails, first fix the issue within the same scope. If the hypothesis is disproved, return to the nearest control boundary and reassess.
6. **Run broader validation:** Once focused checks pass, run Contract, Integration, Regression, and Build checks according to risk.
7. **Remove and synchronize:** Remove superseded paths and update the Spec, ADR, Current Architecture, Plan Item, and documentation index.
8. **Complete the review:** Check acceptance criteria, risks, Deferred items, and unrelated changes before proceeding to commit or merge.

If implementation reveals errors in `Accepted` documents, an invalid dependency direction, or a need to change the migration sequence, pause implementation and list the evidence and options. Architecture document revisions require separate confirmation; do not silently change the architecture in a code commit.

### Documentation Lookup and Synchronization

For routine implementation work, gather evidence in this order: source code and focused tests; one Current Architecture topic that owns the subject; one Stable Specification that owns the subject (only when public behavior or lifecycle contracts are relevant); one Accepted ADR (only when decision rationale is relevant); and the current Active Change (only when the work belongs to an approved delivery).

Do not read or search `docs/changes/archive/`, `docs/evidence/`, `docs/research/`, Deferred items, superseded decisions, or Git history by default. Consult these sources only when the task requires tracing origins, comparing previous approaches, reconstructing a migration, or resolving an incomplete transfer of authority.

Documentation synchronization follows the single prose owner principle: Current Architecture records current boundaries, Stable Specifications record current contracts, ADRs record long-term decision rationale, and Active Changes record temporary delivery details and validation. Local implementation changes do not routinely require updates to ADRs, Archive, or Evidence. Do not change other documents merely to keep wording similar when their authoritative content has not changed.

## 8. Validation Requirements

`package.json` is the authoritative source for established commands. `npm test` is the routine Unit layer; run Integration and Fitness checks according to change impact. `test:all`, lint, and build are final or cross-boundary Gates, not a fixed sequence to run after every edit:

```bash
npm test
npm run test:integration
npm run test:fitness
npm run test:all
npm run lint
npm run build
```

Host, Relay Artifact, real WebSocket, and other environment-dependent validations continue to use their own explicit commands. Run them only when the corresponding boundary changes, during formal review, or at a release Gate. When a full build is about to run against the same source state, do not also run an equivalent full TypeScript no-emit check unless the acceptance criteria explicitly require two independent pieces of evidence.

| Change Type | Minimum Validation |
|---|---|
| Documentation | Documentation diagnostics, link checks, `git diff --check` |
| Small Change | Relevant tests or focused behavioral checks + `npm run lint` |
| Defect | Failure reproduction or regression tests + relevant tests + `npm run lint` |
| Public Contract | Unit/Contract Tests + relevant Integration Tests + `npm run build` |
| Architecture Slice | Focused, contract, integration, and regression checks defined in the Spec + lint + build |
| Spike | Evidence collection defined in the Spike Spec; passing all production tests is not a substitute for validating the hypothesis |

If a check cannot be run, record the reason, uncovered risks, and an actionable follow-up validation method. Do not mask deterministic failures with permissive retry policies or increased timeouts.

## 9. Definition of Done

Work is complete only when all applicable items are satisfied:

- [ ] Confirmed acceptance scenarios pass.
- [ ] Focused validation was run after the first substantive change.
- [ ] New or changed public contracts have tests.
- [ ] The lint, tests, and build required for the change pass.
- [ ] At least one real caller has been migrated.
- [ ] Superseded production paths have been removed or reduced to Compatibility with an owner and expiration date.
- [ ] New code does not depend on Legacy or Compatibility.
- [ ] The ADR, Spec, Results, Current Architecture, and corresponding Plan Item status are synchronized.
- [ ] The documentation index and applicable Change, Evidence, or migration control records are updated.
- [ ] There are no unexplained Diagnostics, unrelated refactoring, or generated noise.
- [ ] Every substantive change is traceable to a confirmed requirement, acceptance criterion, defect evidence, or necessary cleanup directly resulting from the current change; there are no premature abstractions, unrelated optimizations, or cleanup of pre-existing dead code.
- [ ] Remaining risks and Deferred items are traceable.

For Documentation, Small Change, and other work that does not involve real callers or Compatibility, apply only the relevant items. Do not create artificial artifacts to satisfy inapplicable requirements.

## 10. Handling Reviews

Handle each reviewer comment as follows:

1. Verify the facts against code, tests, or authoritative documentation.
2. Mark it as accepted, accepted with modifications, or rejected.
3. Explain the severity, impact, and rationale.
4. Implement only the accepted minimal correction.
5. After the correction, rerun checks that can validate the concern.

Reviewer comments are not automatic instructions. Critical/High issues normally block completion; whether Medium/Low issues block completion depends on actual risk and the current Gate.

## 11. Documentation and Legacy

- `docs/architecture/` contains only facts about the current implementation verified by code, tests, or runtime evidence. Target designs, contracts, and implementation records must not be placed in this directory.
- `docs/decisions/` contains accepted long-term ADRs; `docs/specifications/` contains stable contracts that remain valid after delivery.
- `docs/changes/active/` contains current Plans, designs/Specs, and validation status; `docs/changes/archive/` contains completed Changes whose authoritative content has been routed to the appropriate owning documents. `active` and `archive` are only physical organization and do not introduce new artifact states or workflows.
- `docs/evidence/` contains evidence from completed internal work worth retaining long-term; `docs/deferred/` contains frozen inputs that explicitly do not authorize implementation; `docs/research/` contains external research that cannot override accepted authority.
- ADRs, Module Specs, Spike Specs, and Results use the templates in `docs/templates/`.
- Mark and migrate old documents first. Delete them only after checking unique information, inbound links, and replacement documentation.
- Git preserves history; do not retain copies of old implementations long-term in `src/legacy/` or active documentation.
- Documentation and code may be committed separately, but the corresponding work is not complete until both are synchronized.

## 12. Commit and Scope Discipline

- Commit subjects and bodies must be in English.
- Each commit contains a single explainable scope of change, without unrelated formatting or generated files.
- Do not create commits without explicit approval from the user or project owner.
- Inspect staged files before committing to avoid including other worktree changes.
- Do not rewrite, revert, or overwrite user changes outside the current work.
- Establish checkpoints at phase milestones such as Architecture Foundation, but a separate commit is not required for every small change.

## 13. Templates

- [ADR Template](../templates/adr-template.md)
- [Module Spec Template](../templates/module-spec-template.md)
- [Spike Spec Template](../templates/spike-spec-template.md)
- [Spike Results Template](../templates/spike-results-template.md)
