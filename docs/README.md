# Documentation

This directory is grouped by document purpose rather than by module.

## Conventions

- Manual integration and smoke scripts live under `scripts/`.
- These scripts are intended to be run directly via `npx tsx scripts/<name>.ts` when needed.
- They are not exposed as `package.json` scripts unless they become stable, frequently used project workflows.

## Development Governance

- [Development Workflow](development-workflow.md) — authoritative work classification, approval, readiness, validation, review, and completion rules
- [Contributing](../CONTRIBUTING.md) — concise setup and contribution entry point
- [ADR Template](templates/adr-template.md)
- [Module Spec Template](templates/module-spec-template.md)
- [Spike Spec Template](templates/spike-spec-template.md)
- [Spike Results Template](templates/spike-results-template.md)

## Recommended Reading Order

For a high-level understanding of the existing design documentation, start with the runtime assembly view and then drill down into the main runtime modules. Check each document's own status before treating it as verified current fact.

1. [Runtime / App Assembly Design](architecture/runtime-design.md)
2. [Agent Runner Design](architecture/core-runner-design.md)
3. [Prompt Builder Design](architecture/core-prompt-design.md)
4. [Workspace Design](architecture/core-workspace-design.md)
5. [Tools Design](architecture/core-tools-design.md)
6. [Session Design](architecture/core-session-design.md)

Examples:

```bash
npx tsx scripts/test-exec-platform-shell.ts
npx tsx scripts/test-exec-background.ts
npx tsx scripts/test-exec-yield.ts
npx tsx scripts/test-exec-timeout-tree.ts
npx tsx scripts/test-exec-abort-tree.ts
npx tsx scripts/test-process-kill.ts
npx tsx scripts/test-process-kill-no-output.ts
npx tsx scripts/test-process-kill-after-exit.ts
npx tsx scripts/test-process-kill-race.ts
npx tsx scripts/test-process-kill-tree.ts
npx tsx scripts/test-process-kill-yield-tree.ts
npx tsx scripts/test-process-list-lifecycle.ts
```

## Architecture

Current implementation facts, accepted architecture constraints, design baselines, Specs, and related implementation records. A document's own status determines its authority; this directory is not yet a single verified Current Architecture.

- [Architecture Principles](architecture/architecture-principles.md)
- [Domain Glossary](architecture/domain-glossary.md)
- [Target Architecture](architecture/target-architecture.md) — accepted target boundaries, ownership, runtime flows, lifecycle, and migration constraints; not current implementation status
- [ADR-001 Tool Result Closure and Recovery](architecture/adr-001-tool-result-closure-and-recovery.md) — accepted controlled-Abort closure and crash-repair boundary; production migration remains pending
- [Agent Runner Design](architecture/core-runner-design.md)
- [Runtime / App Assembly Design](architecture/runtime-design.md)
- [Config Design](architecture/platform-config-design.md)
- [LLM Client Design](architecture/adapters-llm-design.md)
- [Prompt Builder Design](architecture/core-prompt-design.md)
- [Session Design](architecture/core-session-design.md)
- [Compaction Design](architecture/core-runner-context-design.md)
- [Memory Design](architecture/core-memory-design.md)
- [Tools Design](architecture/core-tools-design.md)
- [Builtin Tools Design](architecture/core-tools-builtin-design.md)
- [Workspace Design](architecture/core-workspace-design.md)
- [Exec / Process Flow Design](architecture/core-tools-builtin-exec-flow-design.md)
- [Exec / Process Platform Runtime Design](architecture/core-tools-builtin-exec-runtime-design.md)
- [Coding Standards](architecture/coding-standards.md)

## Roadmap

Planned evolution documents, adoption sequencing, and regression checklists for larger refactors.

- [Architecture Foundation Plan](roadmap/architecture-foundation-plan.md) — accepted target-architecture, spike, migration, and legacy-exit plan
- [AF-03 Target Architecture Execution Plan](roadmap/af-03-target-architecture-plan.md) — completed phase record and acceptance evidence for the Target Architecture
- [AF-04 Characterization and Fitness Execution Plan](roadmap/af-04-characterization-fitness-plan.md) — accepted evidence, test-protection, and architecture-fitness execution plan

## Analysis

Reference comparisons and design input; these docs are not the source of truth for this repository's implementation.

- [Claude Code Subagent Analysis](analysis/claude-code-subagent-analysis.md)
- [Subagent Systems Overview](analysis/subagent-systems-overview.md)


## Local Collaboration Notes (Non-authoritative)

These personal collaboration preferences do not define repository governance. The [Development Workflow](development-workflow.md) is authoritative when they differ.

- Spec-driven development — write and confirm design docs before writing code.
- Confirm before changes — discuss any modification first and only proceed after approval.
- Coding standards — follow `coding-standards.md` when it exists in the current workspace.
- Collaboration style — when you disagree, state your reasoning explicitly instead of agreeing just to accommodate.
- Reviewer feedback — treat as suggestions, not directives. Verify facts, triage each item (accept/reject/modify) with reasoning, then apply only accepted changes. Do not blindly accept.
- Commit messages — English only, no Chinese in commit subject or body. Applies to all repos.

NOTE: These can be added to the user-level memory file, for example at:
```
%HOMEPATH%\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\memory-tool\memories\collaboration-preferences.md
```
