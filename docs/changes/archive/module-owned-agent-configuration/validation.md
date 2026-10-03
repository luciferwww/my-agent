# Module-owned Agent Configuration Validation

> Status: Implemented, Validated, and Accepted
> Date: 2026-09-23
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Contract: [Module-owned Agent Configuration Specification](module-owned-agent-configuration-specification.md)

## 1. Implementation evidence

| Boundary | Evidence |
|---|---|
| Leaf ownership | Built-in LLM, Runtime, Runner/Compaction, Memory, Prompt, Tool Policy, Agent Context, Subagent, and Logger own their contracts, immutable defaults, semantic validation, and focused tests |
| Platform composition | `platform/config/types.ts` retains composition contracts and type re-exports; `createDefaultAgentConfig()` creates fresh aggregates from owner defaults without leaf literals |
| Central authority removal | `platform/config/defaults.ts` and mutable `DEFAULT_AGENT_CONFIG` are removed |
| Validation | Owner validators reject invalid and unknown fields, including nested fields; Platform maps failures to exact document paths |
| Runtime wiring | Runtime supplies resolved owner projections while direct Runtime, Runner, Memory, and Logger entry points use the same owner defaults |
| Memory behavior | Resolved chunking changes actual line boundaries; configuration changes invalidate existing per-file indexes; oversized lines cannot stall chunking |
| Dependency direction | FT-14 prevents leaf modules from importing Platform Configuration and prevents centralized leaf defaults/contracts from returning |
| Stable authority | Configuration, Memory, Agent Context, Runner, Tools, Prompt, and Observability documentation describes the final ownership boundary |

## 2. Executed validation

| Check | Result |
|---|---|
| Focused configuration, Memory, and Subagent tests after review fixes | 101/101 passed; final affected rerun 75/75 passed |
| `npm test -- --maxWorkers=1 --no-file-parallelism` on final source state | 101 files, 1,117 tests passed |
| `npm run test:integration` on final source state | 6 files, 18 tests passed |
| `npm run test:fitness` on final source state | 13 files, 43 tests passed |
| `npm run lint` on final source state | Main and relay TypeScript checks passed |
| `npm run build` on final source state | Main and Host builds passed; Host audit passed for 340 files; relay verification passed 45/45 |
| `npm run verify:websocket-host` on final source state | Passed |
| Documentation governance and links | FT-09 passed |
| `git diff --check` | Passed before closeout; rerun after archive |

## 3. Independent review

The independent review reported one High and two Medium issues:

1. Near-full overlap could keep `MemoryIndexer` on the same oversized line indefinitely. Chunking now advances to the prior end when overlap cannot make progress, with a regression test.
2. Unchanged content retained old chunks after a chunking configuration change. The Store now records and compares a per-file chunking fingerprint before skipping indexing.
3. Migrated owner validators accepted unknown leaf and nested-leaf fields. Every owner validator now rejects unsupported keys and preserves exact composed field attribution.

All three findings were fixed and covered by focused regression tests. No remaining Critical, High, or Medium issue is known.

## 4. Acceptance

The project owner accepted the Plan and Specification, authorized Delivery, and requested unattended automatic execution through Change completion. The preserved external document shape/defaults/precedence, newly effective Memory chunking, full gates, and independent review satisfy that authorization. The Change is complete and archived.
