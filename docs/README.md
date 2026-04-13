# Documentation

This directory is grouped by document purpose rather than by module.

## Conventions

- Manual integration and smoke scripts live under `scripts/`.
- These scripts are intended to be run directly via `npx tsx scripts/<name>.ts` when needed.
- They are not exposed as `package.json` scripts unless they become stable, frequently used project workflows.

## Recommended Reading Order

For a high-level understanding of the current design, start with the runtime assembly view and then drill down into the main runtime modules.

1. [Runtime / App Assembly Design](architecture/runtime-app-assembly-design.md)
2. [Agent Runner Design](architecture/agent-runner-design.md)
3. [Prompt Builder Design](architecture/prompt-builder-design.md)
4. [Workspace Design](architecture/workspace-design.md)
5. [Tools Design](architecture/tools-design.md)
6. [Session Design](architecture/session-design.md)

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

Design baselines for the current implementation, including module boundaries, data flow, and behavior contracts.

- [Agent Runner Design](architecture/agent-runner-design.md)
- [Runtime / App Assembly Design](architecture/runtime-app-assembly-design.md)
- [Config Design](architecture/config-design.md)
- [LLM Client Design](architecture/llm-client-design.md)
- [Prompt Builder Design](architecture/prompt-builder-design.md)
- [Session Design](architecture/session-design.md)
- [Memory Design](architecture/memory-design.md)
- [Tools Design](architecture/tools-design.md)
- [Builtin Tools Design](architecture/builtin-tools-design.md)
- [Workspace Design](architecture/workspace-design.md)
- [Exec / Process Flow Design](architecture/exec-process-flow-design.md)
- [Exec / Process Platform Runtime Design](architecture/exec-process-platform-runtime-design.md)
- [Coding Standards](architecture/coding-standards.md)

## Roadmap

Planned evolution documents, adoption sequencing, and regression checklists for larger refactors.

- [Exec Evolution Roadmap](roadmap/exec-evolution-roadmap.md)
- [Exec / Process Platform Adoption Plan](roadmap/exec-process-platform-adoption-plan.md)
- [Exec / Process Platform Regression Checklist](roadmap/exec-process-platform-regression-checklist.md)

## OpenClaw Analysis

Reference analysis of OpenClaw for comparison and design input; these docs are not the source of truth for this repository's implementation.

- [OpenClaw Analysis](analysis/openclaw/openclaw-analysis.md)
- [OpenClaw Agent Command Flow](analysis/openclaw/openclaw-agent-command-flow.md)
- [OpenClaw Agent Runner Analysis](analysis/openclaw/openclaw-agent-runner-analysis.md)
- [OpenClaw Context Files Flow](analysis/openclaw/openclaw-contextfiles-flow.md)
- [OpenClaw Exec / Process Platform Analysis](analysis/openclaw/openclaw-exec-process-platform-analysis.md)
- [OpenClaw Memory Module Analysis](analysis/openclaw/openclaw-memory-module-analysis.md)
- [OpenClaw Message Flow](analysis/openclaw/openclaw-message-flow.md)
- [OpenClaw PI Builtin Tools Memo](analysis/openclaw/openclaw-pi-builtin-tools-memo.md)
- [OpenClaw Prompt System Deep Dive](analysis/openclaw/openclaw-prompt-system-deep-dive.md)
- [OpenClaw Session Analysis](analysis/openclaw/openclaw-session-analysis.md)
- [OpenClaw Tool System Analysis (Current)](analysis/openclaw/openclaw-tool-system-analysis-current.md)
- [OpenClaw Tool System Analysis](analysis/openclaw/openclaw-tool-system-analysis.md)


## Collaboration Principles
- Spec-driven development — write and confirm design docs before writing code.
- Confirm before changes — discuss any modification first and only proceed after approval.
- Coding standards — follow `coding-standards.md` when it exists in the current workspace.
- Collaboration style — when you disagree, state your reasoning explicitly instead of agreeing just to accommodate.

NOTE: These can be added to the user-level memory file, for example at: %HOMEPATH%\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\memory-tool\memories\collaboration-preferences.md