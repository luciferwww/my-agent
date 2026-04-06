# Documentation

This directory is grouped by document purpose rather than by module.

## Conventions

- Manual integration and smoke scripts live under `scripts/`.
- These scripts are intended to be run directly via `npx tsx scripts/<name>.ts` when needed.
- They are not exposed as `package.json` scripts unless they become stable, frequently used project workflows.

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

- [Agent Runner Design](architecture/agent-runner-design.md)
- [LLM Client Design](architecture/llm-client-design.md)
- [Prompt Builder Design](architecture/prompt-builder-design.md)
- [Session Design](architecture/session-design.md)
- [Tools Design](architecture/tools-design.md)
- [Workspace Design](architecture/workspace-design.md)
- [Exec / Process Flow Design](architecture/exec-process-flow-design.md)
- [Exec / Process Platform Runtime Design](architecture/exec-process-platform-runtime-design.md)

## Roadmap

- [Exec Evolution Roadmap](roadmap/exec-evolution-roadmap.md)
- [Exec / Process Platform Adoption Plan](roadmap/exec-process-platform-adoption-plan.md)
- [Exec / Process Platform Regression Checklist](roadmap/exec-process-platform-regression-checklist.md)

## OpenClaw Analysis

- [OpenClaw Analysis](analysis/openclaw/openclaw-analysis.md)
- [OpenClaw Agent Command Flow](analysis/openclaw/openclaw-agent-command-flow.md)
- [OpenClaw Agent Runner Analysis](analysis/openclaw/openclaw-agent-runner-analysis.md)
- [OpenClaw Context Files Flow](analysis/openclaw/openclaw-contextfiles-flow.md)
- [OpenClaw Exec / Process Platform Analysis](analysis/openclaw/openclaw-exec-process-platform-analysis.md)
- [OpenClaw Message Flow](analysis/openclaw/openclaw-message-flow.md)
- [OpenClaw Prompt System Deep Dive](analysis/openclaw/openclaw-prompt-system-deep-dive.md)
- [OpenClaw Session Analysis](analysis/openclaw/openclaw-session-analysis.md)
- [OpenClaw Tool System Analysis (Current)](analysis/openclaw/openclaw-tool-system-analysis-current.md)
- [OpenClaw Tool System Analysis](analysis/openclaw/openclaw-tool-system-analysis.md)