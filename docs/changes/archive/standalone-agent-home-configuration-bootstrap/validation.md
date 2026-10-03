# Standalone Agent Home Configuration Bootstrap Validation

> Status: Archived and Validated
> Date: 2026-09-16
> Owner: Project owner
> Related Plan: [Standalone Agent Home Configuration Bootstrap](plan.md)
> Contract: [Standalone Agent Home Configuration Bootstrap Specification](standalone-agent-home-configuration-bootstrap-specification.md)

## 1. Gate policy

ADR-011, the Plan, and the Specification were accepted before Delivery. Focused checks followed implementation items; full regression, lint, clean build, environment verification, and independent review ran at the final Gate. The project owner accepted closeout and archival on 2026-09-16.

## 2. Current evidence

| Observation | Current evidence |
|---|---|
| Missing configuration is materialized | standalone Host invokes `ensureAgentConfigDocument()` after path resolution and before strict loading |
| Context initialization is independent | Runtime bootstrap calls `ensureAgentContext(agentHome)` after configuration resolution |
| Context files are create-if-missing | Core Agent Context uses exclusive writes and preserves existing content |
| Partial Agent Home is prevented on standalone first start | exact `{}\n` creation precedes Extension Acquisition and Runtime-owned Context/Memory initialization |
| Empty configuration is structurally valid | Existing configuration tests prove `{}` resolves to hardcoded defaults and default Host settings |
| Empty configuration is not operational readiness | Runtime reports an unset default Model and a default Turn fails model resolution without an explicit reference |
| Physical owners are already separated | ADR-010 and its validated Change establish `installDir`, `agentHome`, and non-owning `workingDir` |

These observations justify a configuration-bootstrap Change but do not authorize an installer, setup wizard, Context-owner migration, or automatic Provider/Model selection.

## 3. Delivery evidence matrix

| Boundary | Evidence | Status |
|---|---|---|
| Exact creation | missing parent and existing empty-parent tests prove exact `{}\n` bytes | Pass — focused Configuration/Host set: 60 tests |
| Preservation | valid, malformed, symlinked, and wrong-type existing-path tests | Pass |
| Strict loading | global `loadAgentConfig()` absence is `FILE_MISSING`; injected read failures retain bounded classification | Pass |
| Concurrency | injected `EEXIST`, existing-document preservation, and controlled partial-write failure/rejection | Pass |
| Host ordering | injected seam proves bootstrap before exactly one document-content read, acquisition, and Runtime creation; bootstrap performs no read | Pass |
| Failure short-circuit | bootstrap/load failure invokes neither acquisition nor Runtime | Pass |
| Owner separation | Agent Context implementation is unchanged; acquisition-failure test proves no Context/Memory before Runtime | Pass |
| Runtime boundary | embedded `RuntimeApp.create()` remains config-file independent | Pass — full Runtime regression |
| State persistence | generated document remains after later acquisition failure | Pass |
| Path ownership | package first-start snapshots prove installation and working-directory trees remain unchanged | Pass |
| Package behavior | separate missing-home installed-command scenario materializes exact config bytes; configured WebSocket scenario remains intact | Pass — `npm run verify:package` |
| Architecture boundaries | affected Integration and Fitness suites | Pass — 6 files/17 tests and 12 files/38 tests |
| Regression | `npm run test:all -- --maxWorkers=1` | Pass — 114 files/1,039 tests |
| Static/build | `npm run lint` and clean `npm run build` | Pass — Host build audit 154 files; Relay audits pass |
| Environment Host | package and compiled WebSocket Host verification | Pass |
| Documentation | diagnostics, links, residual scans, `git diff --check` | Pass |
| Review | independent Critical/High/Medium review and owner closeout | Pass — no findings; owner accepted closeout on 2026-09-16 |

The default parallel full suite twice exposed the same pre-existing Windows background-process timing test under load, once while waiting for logs and once while killing a process. The affected file passed in isolation (5/5), and the complete single-worker suite passed (114 files/1,039 tests). No ACB source path participates in that process Tool test.

The first package-verification attempt timed out during temporary-project dependency installation. An unchanged rerun passed and exercised both the new no-Agent-Home first-start scenario and the retained configured WebSocket scenario.

## 4. Design-stage checks

| Check | Result |
|---|---|
| ADR, Plan, Specification, and validation record exist | Pass — 2026-09-16 |
| Decision and Change indexes link the proposal | Pass — 2026-09-16 |
| Relative Markdown links resolve | Pass — 2026-09-16; all links across the six proposal/index documents resolve |
| Editor diagnostics | Pass — no diagnostics in the proposal/index documents |
| `git diff --check` | Pass — 2026-09-16 |
| Independent design review | Pass after corrections — strict-loader scope, error contract, shared container semantics, Host seam/order, one document read, package scenario, deterministic failure injection, and installer retirement are explicit; follow-up found no Critical, High, Medium, or Low issue |
| Owner acceptance | Pass — ADR-011, Plan, and Specification accepted for Delivery on 2026-09-16 |
| Owner closeout | Pass — delivery accepted for archival on 2026-09-16 |

## 5. Final Gate commands

| Command/check | Result |
|---|---|
| Focused Configuration and Host tests | Pass — 60 tests |
| `npm run test:integration` | Pass — 6 files/17 tests |
| `npm run test:fitness` | Pass — 12 files/38 tests |
| `npm run test:all -- --maxWorkers=1` | Pass — 114 files/1,039 tests |
| `npm run lint` | Pass |
| `npm run build` | Pass |
| `npm run verify:package` | Pass on unchanged retry |
| `npm run verify:websocket-host` | Pass |
| Editor diagnostics | Pass — no diagnostics in changed source, tests, scripts, or authority documents |
| Relative Markdown links and `git diff --check` | Pass |
| Independent implementation review | Pass — no Critical, High, or Medium findings |

The review's two Low observations claimed the packaged first-start path lacked implementation/evidence. They are rejected as factually superseded: `scripts/verify-npm-package.mjs` contains the separate no-Agent-Home scenario, and the final Gate executed it successfully. No implementation change followed from those observations.

## 6. Known risk and deferred scope

The generated empty document does not configure a default Model, Provider connection, External Extension entry, or credential. It improves physical configuration consistency but does not make first-run setup complete. The README and diagnostics must not present it as operational readiness.

Exclusive creation prevents overwrite but is not a cross-process transaction. A competitor can encounter an existing document while another process is creating it, and a crash can leave invalid content. Automatic repair and cross-process locking remain explicitly deferred; strict validation preserves the failure for operator action.

Race and partial-write checks use injected filesystem dependencies and controlled bytes. They do not rely on process-crash timing, Windows ACL behavior, or undocumented filesystem atomicity.

Agent Context, Memory, Session, Subagent, Logger, temporary, and Extension initialization remain outside this Change except as negative boundary evidence.

Follow [Development Workflow](../../../governance/development-workflow.md).
