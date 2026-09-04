# AF-06 Extension Framework Spike Results

## 1. 记录

- **Spike 状态：** Completed
- **结果：** Provisional Pass（项目所有者已接受）
- **执行日期：** 2026-09-03
- **接受与清理日期：** 2026-09-03
- **时间盒证据：** 开始与结束均为 2026-09-03；实际执行小于 1 个工作日，未达到 3 个工作日建议时间盒或 5 个工作日硬停止
- **所有者：** 项目所有者
- **执行环境：** Windows；Node.js `v22.22.2`；npm `10.9.7`；TypeScript `5.9.3`；Vitest `3.2.4`
- **执行基线：** commit `a578475258ec2cc2fa755392b7cdd7495bdd8448`；branch `feature/refactoring`
- **Spike Spec：** [AF-06 Extension Framework Spike Spec](af-06-extension-framework-spike-spec.md)（`Accepted`，2026-09-03）
- **父计划与语言约定：** [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)
- **权威目标：** [Target Architecture §6](target-architecture.md#6-extensionmodulecontribution-and-registry)、[§7](target-architecture.md#7-registry-snapshot-and-lifecycle-transactions)、[§8](target-architecture.md#8-runtime-call-flows-and-ownership)、[§10](target-architecture.md#10-verification-and-acceptance-matrix) 与 [Appendix C](target-architecture.md#appendix-c-af-06-extension-framework-spike-input)
- **相关约束：** [Architecture Principles](architecture-principles.md)、[Domain Glossary](domain-glossary.md)
- **工作流：** [Development Workflow](../development-workflow.md)

本 Results 记录 production graph 外的 disposable AF-06 Spike 证据。`P3-E01..P3-E05` 与 `P4-E01..P4-E07` 均通过，未命中 Stop Condition；项目所有者于 2026-09-03 接受 `AF06-H01` 的 `Supported / Provisional Pass` 评估。随后已删除全部 disposable fixture 并完成 cleanup validation，因此 Spike 状态为 `Completed`。

该结果不接受 production TypeScript API，不授权生产 dynamic reload、文件 watcher、同一 Extension 的运行中版本替换、多 instance 并存、Framework 管理 Extension 内部对象、AF-07、Architecture Slice 或 Foundation Gate 整体通过。

## 2. 执行范围

实验执行时只新增于 `test-fixtures/architecture-spikes/af-06/**`；这些 disposable 文件已在 Results 获接受后全部删除：

- `contracts/types.ts`：disposable Descriptor、Contribution、typed projection、Capability、Snapshot、request result 与实例级 Lifecycle shape；
- `acquisition/discovery.ts`：direct-child discovery、规范目录键、Descriptor/path/Schema stage-one 校验与 controlled loader；
- `registry/registry.ts`：统一 staging API、Config migration、Capability validation、acquisition priority、whole-unit conflict isolation 与 immutable Snapshot；
- `lifecycle/coordinator.ts`：candidate/pending/retiring slots、request results、publish、retirement、instance-level stop 与 Shutdown；
- `turn-tree/turn-tree.ts`：Root capture、Child inheritance、generation pin、Abort 与 release；
- `fixtures/units.ts`：同一 integrated External chat fixture factory、Builtin fixture、四类 Contributions、opaque private sentinel 与 lifecycle telemetry；
- `runner-bridge/agent-runner-bridge.ts`：真实 `AgentRunner` 的静态 Tool dispatcher 和一次注册的 `before_tool_call` dispatcher；
- `analysis/boundary-scan.ts` 与 `positive-control.ts.txt`：有限、预先声明的 AST denial rule 与 compile-negative positive control；
- `af-06-extension-framework.spike.ts`：12 个 canonical evidence group、28 tests 和一个非 canonical Shutdown/publish probe；
- fixture-local `tsconfig.json` 与 `vitest.config.ts`：隔离 production build 和 root test discovery。

没有修改 production source、production test seam、public Contract、dependency、package metadata 或 lockfile。实验没有读取 secret、访问网络、启动真实 WebSocket、调用真实 Provider 或产生费用；全部 Transport、Provider、platform action、deadline 和冲突输入均为 deterministic fixture。

## 3. 执行步骤与命令

### 3.1 首个可证伪场景

```text
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-06/tsconfig.json
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts -t "P3-E02|P3-E05"
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts -t "P4-E01"
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts -t "AF06-PROBE-SHUTDOWN-PUBLISH"
```

结果：

- fixture TypeScript：通过，无 diagnostics；
- `P3-E02|P3-E05`：1 file / 2 passed / 13 skipped；3.53s；
- `P4-E01`：1 file / 1 passed / 14 skipped；1.86s；
- `AF06-PROBE-SHUTDOWN-PUBLISH`：1 file / 1 passed / 14 skipped；1.83s；该 probe 不计作 `P4-E07` Pass。

### 3.2 完整矩阵收敛

首次完整矩阵为 14 passed / 1 failed。失败原因是 compile-negative positive control 的 expected diagnostic code 与 TypeScript `5.9.3` 实际结果不一致；冻结实际 code 后，第二次运行又暴露 expected line location 偏差。修正 line 后，有限 AST scanner 对正常数组数字索引产生 `arbitrary-token-lookup` false positive。scanner 被最小收窄为 identifier-based dynamic element lookup，未减少 positive control 的五类违规；随后 15/15 通过。

独立实现复审指出多项 evidence assertion 不足，而非 Target Hypothesis 反例。最小补强包括：每类 Contribution registration failure、Snapshot-build/pre-commit failure、A/B/C request slot、两种 capture/publish 顺序、N+1 在 N nonconvergence 时完成、dynamic winner 经 enable/publish/retirement、instance-observed reverse stop order、共享 Shutdown result、active candidate/retiring/failed-retirement Shutdown、static Schema reject、四类 projection 实际消费、External/External conflict permutations、structured candidate residual 和每场景 instance cleanup。最终 suite 为 28 tests。

### 3.3 最终 Spike evidence

```text
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-06/tsconfig.json
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts
```

最终结果：

- fixture TypeScript：通过，无 diagnostics；
- Spike suite：1 file / 28 tests passed；`P3-E01..P3-E05`、`P4-E01..P4-E07` 和非 canonical probe 全部通过；最新 review-correction run 为 3.45s；
- `.spike.ts` 仅由 fixture-local Vitest config 发现；root regression 保持 72 files / 695 tests，未重复执行 AF-06 suite。

### 3.4 AF-04 保护线

```text
npm test -- src/architecture-fitness/ft-05-extension-capability.test.ts src/architecture-fitness/ft-06-change-locality.test.ts src/architecture-fitness/ft-07-registry-snapshot.test.ts src/architecture-fitness/ft-08-contract-inventory.test.ts
npm test -- src/core/runner/AgentRunner.test.ts src/runtime/RuntimeApp.test.ts -t "CH-04|CH-07|CH-08|CH-10|CH-12"
```

结果：

- Fitness protection：4 files / 8 tests passed；1.89s；
- Characterization protection：2 files passed；8 passed / 67 skipped；5.39s。

### 3.5 Repository 收口检查

```text
npm run lint
npm test
npm run build
git diff --check
```

最终结果：全部通过；root regression 为 72 files / 695 tests passed，9.25s；输出中未发现 AF-06 fixture 或 `.spike.ts`；production build 未包含 AF-06 fixture；`git diff --check` clean；package/lockfile/`src/**` diff count 为 0。四个变更文档的 UTF-8 local file/fragment audit 检查 75 个 links，0 missing。

review correction 后的首次完整回归出现两个既存 process tests 的 5s timeout。focused 两文件 10/10 passed；诊断发现 editor test runner 遗留 370 个 `vitest.explorer` workers，且无遗留 fixture `tick` child。只终止这些 runner workers、未修改工作树或 timeout 后，完整 `npm test` 以 72/695 全绿。该环境干扰不作为 AF-06 architecture evidence，也未通过放宽 timeout、增加 retry 或修改 production 掩盖。

### 3.6 接受后清理验证

项目所有者接受 Results 后，按 Spec §14 删除 `test-fixtures/architecture-spikes/af-06/**` 全部 12 个文件及其空目录；路径检查确认整个 AF-06 disposable directory tree 已不存在。随后运行 `npm run lint`、`npm test`、`npm run build` 和 `git diff --check`，四项 exit code 均为 0；root regression 为 72 files / 695 tests passed，13.39s，未发现 `.spike.ts` 或 AF-06 fixture；package、lockfile 与 `src/**` diff count 为 0。

第一次 cleanup 检查时 12 个文件已删除且四项命令全部通过，但空的 AF-06 directory tree 仍存在，因此未把该次路径检查记为完成。删除空目录后再次确认路径不存在，并复跑四项命令；最终全部通过。cleanup evidence 完成后才将本 Spike 晋升为 `Completed`。

## 4. 冻结输入与结果表

### 4.1 目录与冲突规则

| 输入 | 冻结规则 | 实际观察 |
|---|---|---|
| External 安装目录键 | lowercase ASCII kebab key；code-unit lexicographic first-wins | `alpha-*` 在正反输入顺序中均胜过 `zulu-*` |
| 非 direct-child、loose script、non-canonical case | stage one 静态拒绝 | loader execution count 不增加 |
| missing field、entry path escape、obsolete/future Schema | stage one 静态拒绝 | loader execution count 为 0 |
| 重复 External ID | 目录键 first-wins；loser 整组隔离 | warning 含 winner/loser/identity/order |
| External/External Contribution conflict | 目录键 first-wins；loser 整组隔离 | 四类 Contributions 不部分发布 |
| Builtin/External conflict | acquisition priority 由 source acquisition 提供；Builtin 胜出 | Registry 下游不按 concrete source identity 分支 |
| 重复 Builtin ID | fatal，Snapshot 不发布 | 独立 assertion row Pass |
| Builtin/Builtin Contribution conflict | fatal，Snapshot 不发布 | 独立 assertion row Pass |

该目录键只是 pure fixture rule，不证明真实 Windows/Linux/macOS filesystem portability，也不冻结 production naming policy。

### 4.2 Descriptor、Schema 与 Config

| 场景 | Entry execution | 结果 |
|---|---:|---|
| valid `config/v2` direct child | 1 | loaded、validated |
| missing descriptor field | 0 | static reject |
| `../outside.js` entry | 0 | static reject |
| loose script / nested candidate / non-canonical directory | 0 | ignored or static reject |
| obsolete `config/v0` / future `config/v9` | 0 | static reject |
| `config/v1` + explicit migration | 1 | migrated to validated namespace input |
| `config/v1` without migration | fixture register only；未 start | rejected |
| invalid migrated/current content | fixture register only；未 start | rejected |
| two namespaces with same field names | independent | values remain isolated |

### 4.3 Boundary positive control

| Evidence | Frozen result |
|---|---|
| compile-negative diagnostics | `TS2307` line 1、`TS2552` line 16、`TS2339` line 17 |
| finite AST positive-control kinds | forbidden import、arbitrary token lookup、Runtime private access、concrete source branch、Transport downcast |
| formal post-acquisition fixture scan | 0 violations for the same five rules |
| internal sentinel access | runtime own-property absence + `TS2339` compile-negative denial |
| real Runner bridge | one static Tool executor + one `before_tool_call` registration；no per-generation Runner Factory |
| `after_tool_call` | 未作为 pass evidence；current detached behavior 与 Target awaited `allSettled` 仍是 production Contract gap |

四类 projection 的可区分调用计数为 Channel `1`、Tool/action `1`、Hook `1`、Provider `1`。同一成功路径上的 external-effect sentinels 为 network `0`、secret read `0`、paid call `0`；它们只证明该 disposable fixture 未触发这些外部效果，不证明真实集成安全。

### 4.4 Request terminal results

| Request role | Expected | Actual |
|---|---|---|
| own candidate fails before publish | `rejected` | Pass；request ID retained |
| overwritten A/B/D request | `superseded` | Pass；later cleanup failure does not rewrite |
| latest/pending/future blocked by nonconvergence | `blocked` | Pass；slot cleared or request prevented from start |
| pending/active candidate cancelled by Shutdown | `shutdown/cancelled` | Pass；request ID retained |
| same identity already active | warning + `no-op` | Pass；candidate start count remains 0 |
| publish succeeds, later retirement fails | `published` remains unchanged | Pass |

### 4.5 Lifecycle and failure matrix

| Boundary | Injected result | Observed containment |
|---|---|---|
| load / each Channel, Tool, Hook, Provider registration / Config / Capability | pre-start failure | no staged unit、neighbor Snapshot unchanged、no start/stop |
| instance start / readiness / handoff | post-start failure | creator retains rollback ownership；one `stop()` |
| Snapshot build / pre-commit | failure | current generation unchanged；candidate stopped once；request rejected |
| candidate cleanup | first stop fails | candidate/Extension/Owner/error residual；future reload blocked；Shutdown one bounded retry |
| Root capture vs publish | both orderings | capture-before sees N；commit-before sees N+1 |
| Child after N+1 publish | Parent pinned to N | Child inherits N；new Root uses N+1 |
| short / Abort-responsive old tree | drain/converge | pin released once；old instance stopped once |
| nonresponsive old tree | Abort does not converge | instance not stopped；generation/Extension/Owner/blocking tree retained；new N+1 Root completes |
| instance stop after publish | first stop fails | N+1 remains current；published result unchanged；pending/future blocked |
| dynamic External winner change | alpha conflicts with current zulu | alpha publishes atomically；zulu retires and stops |
| Shutdown active candidate/current/retiring/failed-retirement | normal、pinned、stop failure | request settlement、pin protection、residual attribution、safe independent stops |
| repeated/concurrent Shutdown | same operation | identical Promise/result；no second stop attempt |

Framework instrumentation only records Extension/Module instance start/stop、Owner、generation pin、request/slot 和 residual。它不读取 sentinel，不建立 Extension-internal membership、reference count、dependency graph 或 close order。

### 4.6 Pre-publish failure retained state

| Injection | Current/published generation | Candidate residue | Retiring residue | Pending disposition | Structured diagnostic | Stop attempts |
|---|---|---|---|---|---|---:|
| load/prepare | `1`，`builtin.core` unchanged | none | none | none | request `failed-request` / boundary `load` | 0 |
| Config validation | `1`，`builtin.core` unchanged | none | none | none | request `failed-request` / boundary `config` | 0 |
| Capability validation | `1`，`builtin.core` unchanged | none | none | none | request `failed-request` / boundary `capability` | 0 |
| instance start boundary | `1`，`builtin.core` unchanged | none after convergent rollback | none | none | request `failed-request` / boundary `start` | 1 |
| readiness | `1`，`builtin.core` unchanged | none after convergent rollback | none | none | request `failed-request` / boundary `readiness` | 1 |
| Snapshot build | `1`，`builtin.core` unchanged | none after convergent rollback | none | none | request `failed-request` / boundary `snapshot-build` | 1 |
| pre-commit | `1`，`builtin.core` unchanged | none after convergent rollback | none | none | request `failed-request` / boundary `pre-commit` | 1 |
| readiness + failed cleanup | `1`，`builtin.core` unchanged | `failed.candidate` + Owner + stop error | none | future request `blocked` | request result `rejected` + structured blocked residual | 1 before Shutdown；2 after bounded retry |
| post-publish retirement stop | `2` remains current；publish result unchanged | none | generation `1` + Extension + Owner + stop error | pending/future `blocked` | structured retirement and Shutdown residual | 1 before Shutdown；2 after bounded retry |

每个 convergent `P4-E02` row 显式断言 current Snapshot、request ID/result、active candidate absence、retiring absence、pending absence、blocked residual absence、boundary diagnostic 和 stop count。nonconvergent candidate/retirement rows另行断言可归属 residual 与后续 request disposition。

## 5. Canonical evidence disposition

精确 test locator：`test-fixtures/architecture-spikes/af-06/af-06-extension-framework.spike.ts`。

| ID | 实际观察 | 结果 |
|---|---|---|
| `P3-E01` | direct-child/static rejection、zero loader execution、duplicate External、External/External、Builtin/External、duplicate Builtin、Builtin/Builtin conflict 与正反排列均符合冻结规则 | Pass |
| `P3-E02` | 同一 integrated fixture factory 对每个 staging boundary 注入失败；handoff 前 creator rollback，handoff 后唯一 instance Owner；零 partial unit、neighbor unchanged、stop once、internal sentinel denied | Pass |
| `P3-E03` | Builtin/External 经一个 API 形成 Channel/Tool/Hook/Provider projections；四类均实际消费；positive control 命中五类 rule，formal scan 为 0；真实 Runner 使用静态 Tool/`before_tool_call` dispatch | Pass |
| `P3-E04` | namespace 隔离；obsolete/future Schema 在 entry 前拒绝；supported/migrated 成功；missing migration/content failure 整组拒绝 | Pass |
| `P3-E05` | required startup capability 缺失整组拒绝；optional 缺失原子 degraded；typed identity + current-call capability 执行 action；missing capability action count 不增加 | Pass |
| `P4-E01` | capture-before/commit-before 均有单一结果；N Parent/Child 不混代；新 Root 使用 N+1；tree pin 只释放一次 | Pass |
| `P4-E02` | prepare 至 pre-commit failure 均不污染 current；own request rejected；cleanup nonconvergence attributable；future blocked；Shutdown bounded retry | Pass |
| `P4-E03` | A/B/C latest-wins、superseded 不改写、duplicate pre-start no-op、retirement sole pending latest 与旧 pending superseded | Pass |
| `P4-E04` | short/Abort-responsive/nonresponsive 三分支；有 pin 不 stop；N+1 在 N nonconvergence 时继续接受并完成 Root | Pass |
| `P4-E05` | post-publish stop failure 不回滚 N+1 或改写 published success；pending/future blocked；Shutdown residual + bounded retry | Pass |
| `P4-E06` | different-identity External winner 和 Builtin winner 均经 enable -> candidate -> atomic publish -> old retirement；warning 可审计 | Pass |
| `P4-E07` | candidate/current/retiring/failed-retirement、publish probe、pin protection、reverse dependency stop、independent failure、single shared Shutdown result 均可观察 | Pass |

`AF06-PROBE-SHUTDOWN-PUBLISH` 仅证明 harness 能表达 Shutdown-first 与 publish-first 两种顺序；完整 `P4-E07` Pass 来自独立 canonical assertions，不由 probe 替代。

## 6. 假设评估

| 假设 | 直接证据 | 共享证据 | 评估 |
|---|---|---|---|
| `P3-H01` discovery/order | `P3-E01` | `P3-E04`、`P4-E06` | Supported |
| `P3-H02` staging/ownership | `P3-E02` | `P3-E05`、`P4-E02` | Supported |
| `P3-H03` one API/projections | `P3-E03` | `P3-E02`、`P3-E05` | Supported |
| `P3-H04` Config/Schema | `P3-E04` | `P3-E01`、`P4-E02` | Supported |
| `P3-H05` typed platform capability | `P3-E05` | `P3-E02`、`P3-E03` | Supported |
| `P4-H01` generation pin | `P4-E01` | `P4-E04`、`P4-E07` | Supported |
| `P4-H02` pre-publish containment | `P4-E02` | `P3-E02`、`P4-E03` | Supported |
| `P4-H03` latest-wins/no-op/pending | `P4-E03` | `P4-E02`、`P4-E05` | Supported |
| `P4-H04` drain/Abort | `P4-E04` | `P4-E05`、`P4-E07` | Supported |
| `P4-H05` post-publish failure | `P4-E05` | `P4-E04`、`P4-E07` | Supported |
| `P4-H06` dynamic winner change | `P4-E06` | `P3-E01` | Supported |
| `P4-H07` bounded Shutdown | `P4-E07` | `P4-E02`、`P4-E04`、`P4-E05` | Supported |
| `AF06-H01` aggregate | 全部 canonical evidence Pass | `AF06-ST01..10` 未命中 | Supported / Provisional Pass |

该评估只适用于 disposable target-shaped coordinator、fake chat protocol、fake Provider、finite denial scanner、controlled ordering 和 Windows execution。

## 7. Stop Condition disposition

`AF06-ST01..AF06-ST10` 均未命中：

- 未修改 production、public Contract、dependency、package metadata、lockfile 或 production test seam；
- 未复制 `RuntimeApp` queue/Fanout/Session/Shutdown loop 或 `AgentRunner` LLM/Tool loop；
- 未引入第二 Runtime、scheduler、Event Bus、DI Container 或 Service Locator；
- Extension 没有取得全局 Config、Runtime private state、Transport payload 或 arbitrary token；
- Descriptor/path/Schema safety 在 controlled entry execution 前判断；
- failure 不产生 partial publish，Snapshot 不可变，Root/Child 不混代；
- instance Owner、generation、blocking tree 和 stop error 均可定位；有 pin 时不强制 stop；
- nonconvergence 后不启动额外 candidate 或第二 retiring generation；
- 没有 wall-clock sleep、timeout enlargement、retry masking 或 swallowed cleanup failure；
- 没有从单一 Windows run 推导真实跨平台 filesystem 结论；
- 执行小于 1 个工作日。

## 8. 当前实现差距与限制

- current production 尚无 Runtime Builder、统一 Extension API、cross-kind Registry Snapshot、generation pin、reload coordinator 或 staged bounded Shutdown；
- current `RuntimeToolBundle` 仍可变，Channel lifecycle 仍由 `RuntimeApp` 直接管理；本 Spike 没有修改这些事实；
- current `AgentRunner` 只证明静态 Tool executor 和一次 `before_tool_call` registration 可消费 turn-keyed projection；Runner 不拥有 Snapshot，bridge-local map 不是 production proposal；
- current `after_tool_call` detached 行为不满足 Target awaited `allSettled`，且未作为 AF-06 pass evidence；
- Descriptor、Schema、Error、deadline、request result 和 TypeScript shape 都是 disposable evidence，不冻结 production Contract；
- in-memory proprietary protocol 不证明真实 WebSocket、第三方平台、认证、rate limit、backpressure 或 reconnect compatibility；
- Extension private sentinel 只证明 boundary opacity；不验证也不规定 Extension 内部对象如何共享、引用、排序或关闭；
- fake Provider 不证明真实 Provider compatibility；
- finite AST rule 只验证 Spec 冻结的五类 forbidden pattern，不是通用安全分析器；
- generation coordinator 只验证单 current、单 candidate、单 retiring、单 pending latest；不支持或授权多代并行 retirement；
- same-identity duplicate 只验证 warning/no-op；不支持或授权运行中版本替换或多 instance；
- Windows execution + pure permutation rule 不构成真实跨平台 filesystem 证明；
- root regression 只保护 current behavior，不能替代后续 Module Spec、Contract tests 和 production migration validation。

## 9. 独立复审

首次实现复审结论为 `Not ready`，指出 P4-E01 单序列、P4-E06 未经 lifecycle、P4-E07 self-referential stop order/状态矩阵/重复 Shutdown、P3-E04 static Schema evidence、P4-E04 N+1 liveness、P4-E03 request coordination、P4-E02 pending/result attribution、P3-E01 Builtin rows/cleanup和 internal sentinel denial 等问题。有效 findings 均以同一 disposable fixture 内的最小 instrumentation/assertion 修正；要求无限语义 alias 扫描、把 Results 缺失当作 fixture defect、或在 later convergence 后自动解除 Target 明确的 process-level block 未采纳。

第二次复审仍报告 P4-E07 coordinator state matrix 一个 High，以及 P3-E01 External conflict、P3-E02 neighbor/partial visibility、P3-E03 Channel/Provider consumption、P4-E02 structured residual 四个 Medium。随后补齐 active candidate/retiring/failed-retirement Shutdown、instance-observed reverse order、四类 projection 调用、External conflict permutations、zero staged unit/neighbor unchanged 和 candidate residual assertion。

fixture gate review 结论为 `Ready`：上述 findings 全部关闭；没有新的 Critical、High 或 Medium 问题阻止起草 `Provisional Pass` Results。

Results closure 首轮复审另外指出：被 Shutdown pin 保护的 test instance 在场景退出时仍有未释放 Root、convergent failure rows 未完整保留 slot/residual/diagnostic absence，以及 network/secret/paid counters 只在文字中声明。有效 findings 以最小改动关闭：场景结束前显式释放 protected Root；每个 `P4-E02` row 断言 active candidate、retiring、pending 和 residual absence及 structured boundary diagnostic；`P4-E05` 补充 retiring/pending/residual state；成功路径补充三个 zero counters。关于“四类 projection 未实际消费”的 finding 与现有 Channel/Provider direct call、Runner Tool/Hook call及四个 counter assertions 不符，未增加重复 suite，仅在 §4.3 保留精确计数。

## 10. 决策影响

项目所有者已接受本 `Provisional Pass`；它可以作为以下后续工作的输入：

- AF-07 的 Extension/Module/Registry 与 Runtime Composition ADR；
- Slice 3/4 的 startup-only immutable Snapshot、统一 API、typed projection、Config Namespace、Capability 和 instance ownership handoff Module Spec；
- Slice 5 的 enable/disable、Turn generation pin、Reload Transaction、Generation Retirement 与 bounded Shutdown Module Spec；
- Foundation Gate 中 AF-06 两个 evidence items 的后续 Owner decision。

它不授权直接复制 fixture types/coordinator，不决定 production API、目录、锁、deadline、Error union 或 Host signal policy，也不使 Foundation Gate 整体通过。

## 11. 工作树与可复现性

执行与接受前 review 时，基线 commit 之后的 AF-06 工作树只包含：

- `docs/architecture/af-06-extension-framework-spike-spec.md` 状态更新；
- `docs/architecture/af-06-extension-framework-spike-results.md`；
- `docs/roadmap/architecture-foundation-plan.md` AF-06 状态/链接；
- `docs/README.md` 文档索引；
- `test-fixtures/architecture-spikes/af-06/**` 12 个 disposable files，现已全部删除。

`package.json`、lockfiles、`src/**` 和 production config 均无变化。Results review 前保留了 fixture；接受后的 mandatory cleanup 已删除整个 AF-06 directory，因此 isolated Spike 命令不再可执行。本 Results 保留环境、命令、matrix、counter 和复审记录作为 durable evidence；repository lint/test/build 仍可复现。

## 12. 后续工作

- [x] 项目所有者于 2026-09-03 接受本 `Provisional Pass`；
- [x] 删除 `test-fixtures/architecture-spikes/af-06/**` disposable fixture；
- [x] cleanup 后运行 `npm run lint`、`npm test`、`npm run build` 和 `git diff --check`；
- [x] cleanup evidence 完成后将 AF-06 晋升为 `Completed`，同步父计划、Target evidence wording、Foundation Gate 和 docs index；
- [ ] AF-07 需由独立授权开始；本次接受与清理不自动授权 AF-07；
- [ ] 任一 production Slice 开始前创建并接受对应 Module Spec，不复制 disposable harness。
