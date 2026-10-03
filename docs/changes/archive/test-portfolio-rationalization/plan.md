# Test Portfolio Rationalization Plan

> Status: Archived — TPR-0 through TPR-4 accepted and completed
> Date: 2026-09-15
> Accepted: 2026-09-15
> Archived: 2026-09-15
> Owner: Project owner
> Type: Test infrastructure and maintenance change

## Delivered scope

The change retired all 33 tracked research-era `scripts/test-*` programs and removed three broken package commands. It retained supported Host, build, audit, Relay artifact, and WebSocket verification scripts. No research script remained as an opt-in operational check, and the unrelated untracked `scripts/test-llm-proxy.ts` diagnostic was not modified.

Five evidence-backed exception proposals produced minimal maintained coverage for completed-process kill idempotence, real process-tree termination, WebSocket payload limits, SQLite reopen persistence, and image-bearing Compaction persistence/dehydration. Existing CH-11 already covered reopened persisted Compaction history, so it was strengthened rather than duplicated.

The project now exposes four automated tiers:

- `npm test` / `test:unit` for the default Unit tier;
- `test:integration` for explicit cross-process, Host, and wire checks;
- `test:fitness` for Architecture Fitness;
- `test:all` for final complete regression.

Development Workflow v1.3 makes focused, impact-driven checks the delivery default and reserves complete regression, lint, and build for final or cross-cutting Gates.

## Preserved boundaries

No production behavior, public contract, lifecycle semantic, stable ID, module ownership, or compatibility path changed. Distinct failure, cancellation, concurrency, process-tree, persistence, security, and artifact-boundary evidence was retained. Git remains the archive for discarded exploratory permutations.

## Validation

- Unit: 94 files / 969 tests passed;
- Integration: 6 files / 15 tests passed;
- Architecture Fitness: 12 files / 38 tests passed;
- final full regression: 112 files / 1,022 tests passed;
- root TypeScript lint and clean build passed;
- Relay error-boundary and artifact audits passed;
- residual scans, documentation diagnostics, and diff formatting passed;
- independent review reported PASS with no Critical or High finding; both Low findings were resolved and focused validation passed.

Detailed baseline, dispositions, timing observations, and final results are retained in the [inventory](inventory.md).

## Closeout

The project owner accepted TPR-0 through TPR-4 on 2026-09-15. This Plan is archived as delivery provenance; [Development Workflow](../../../governance/development-workflow.md), package commands, and Vitest tier configurations own the ongoing validation process.
