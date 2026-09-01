# AF-04 Characterization and Fitness Execution Plan

## 1. 文档状态

- **状态：** Accepted
- **版本：** 1.0
- **日期：** 2026-08-31
- **所有者：** 项目所有者
- **父计划：** [Architecture Foundation Plan](architecture-foundation-plan.md) AF-04
- **权威架构：** [Target Architecture](../architecture/target-architecture.md) Appendix A
- **架构原则：** [Architecture Principles](../architecture/architecture-principles.md) FT-01..FT-09

本计划管理 AF-04 的证据盘点、Characterization Tests、Architecture Fitness Tests 和完成评审。它不改变生产行为，不执行 AF-05/AF-06，不把 Target Decision 写成 Current Fact，也不授权任何生产 Architecture Slice。

## 2. 目标与退出条件

### 2.1 目标

1. 用可重复测试固定迁移前必须保留或有意替换的当前行为；
2. 用可执行规则阻止已接受架构的依赖方向、权威来源和扩展边界倒退；
3. 将当前事实、已知缺陷、目标行为和暂时例外明确分离；
4. 为 AF-05、AF-06 和后续 Architecture Slice 提供可信保护线，而不提前实现它们。

### 2.2 总体退出条件

- [ ] CH-01..CH-14 均有定位到代码/现有测试/运行观察的当前证据和最终 disposition；
- [ ] P0 Characterization Tests 覆盖 CH-01..CH-10；
- [ ] P1 Characterization Tests 覆盖 CH-11..CH-14；
- [ ] FT-01..FT-09 均有可执行规则、最小 expected-failure fixture 和可定位诊断；
- [ ] 每项当前 FT 违规均以失败基线或临时例外显式呈现；任何生产修复必须作为单独批准的 Defect 或 Architecture Slice 执行；
- [ ] 测试中的并发、时间、I/O 和失败注入具有确定性控制，不依赖扩大超时碰运气；
- [ ] AF-04 Completion Record 包含命令、环境、覆盖映射、通过/预期失败、例外和残余风险；
- [ ] 独立评审无未解决 Critical/High finding；
- [ ] 项目所有者确认结果，并只按真实证据同步 Foundation Gate。

## 3. 权威输入与证据边界

| 输入 | 状态 | AF-04 用途 |
|---|---|---|
| [Development Workflow](../development-workflow.md) | Accepted v1.0 | 状态、批准、验证、评审和提交规则 |
| [Architecture Foundation Plan](architecture-foundation-plan.md) | Accepted v1.1 | AF-04 范围、Foundation Gate 与 §7.4 文档语言和术语约定 |
| [Target Architecture](../architecture/target-architecture.md) | Accepted v1.2 | CH-01..CH-14、FT-01..FT-09、迁移 disposition 和结果边界 |
| [ADR-002 Context Budgeting and Compaction Recovery](../architecture/adr-002-context-budgeting-and-compaction-recovery.md) | Accepted | Provider-owned model limits、预算权威、Compaction 验收、overflow correction 和生命周期边界 |
| [Architecture Principles](../architecture/architecture-principles.md) | Accepted v1.0 | Fitness Test 规范语义 |
| [Domain Glossary](../architecture/domain-glossary.md) | Accepted v1.4 | Current、Target、Policy、Registry、Turn 等规范词义 |

证据按以下规则解释：

1. 代码、现有测试和可重复运行观察可以证明核验时点的 Current Fact；旧文档只能提供候选定位；
2. Characterization Test 记录当前可观察行为，不因 Target Architecture 偏好而改写断言；
3. `Preserve` 表示后续 Slice 默认保持，`Characterize then replace` 表示先固定现状再由已接受 Contract 有意改变，`Baseline` 只建立定位能力；
4. expected-failure fixture 证明 Fitness rule 能拦截违规，不表示生产代码当前违规；
5. 生产代码当前违反 FT 时，先记录 rule、actual edge/fact、evidence 和建议 Owner，形成 current violation inventory，不得静默扩大 allowlist；若要暂时豁免 Accepted Architecture Principle，则必须由 `Accepted` ADR 记录 scope、reason、Owner、expiry date 和 removal condition；
6. AF-04 证据不能升级 AF-05/AF-06 Hypothesis，也不能证明生产代码已实现 Target Architecture。

## 4. 范围

### 4.1 范围内

- Target Architecture Appendix A 的 CH-01..CH-14；
- Architecture Principles 和 Target Architecture 中同一组 FT-01..FT-09；
- 为上述行为所需的 Unit、Contract、Integration、failure-injection 和静态检查；
- 最小 deterministic fake、barrier、fixture 和 compile-fail/invalid-doc fixture；
- 当前违规例外登记、完成证据、必要的 Current Architecture 事实更新；
- AF-04 完成后的父计划和文档索引同步。

### 4.2 非目标

- 实现 Target Architecture、Model Resolver、Extension Framework 或动态 Registry；
- 修复 Characterization 暴露的生产缺陷，除非另行分类、确认和提交；
- 改变公共 API、Event、Error、并发、Lifecycle 或 Resource Ownership 契约；
- 执行 AF-05/AF-06、编写其 Results 或提前接受相关 ADR/Spec；
- 通过大幅延长 timeout、宽松重试或快照整段内部结构来制造稳定测试；
- 引入通用测试框架、依赖分析平台或仓库级重构；
- 让任何生产 Architecture Slice 进入 Delivery。

## 5. 执行规则

1. 本计划必须先由项目所有者晋升为 `Accepted`，之后才允许扫描生产代码/测试和实现 AF-04；
2. Phase 按顺序推进，同一时间只允许一个 Phase 为 `In Progress`；
3. 每个 CH/FT 从一个最小代码、测试或命令锚点开始，不做无边界全仓扫描；
4. 首个测试或规则改动后立即运行能推翻当前假设的最小检查；
5. Characterization 与未来 Target Contract Tests 使用不同名称和目录语义，避免把待替换缺陷永久化；
6. 优先复用仓库现有 Vitest、TypeScript 和脚本能力；新增依赖、公共 test seam 或生产导出前必须暂停并取得批准；保持行为、公共 API/export surface 和依赖方向不变的私有生产重构也必须按单独 Small Change/Defect 确认范围并聚焦验证；
7. 每个 Phase 完成前执行独立评审并由项目所有者确认 Plan Item；
8. 测试与文档可以分开提交，但每个提交必须范围单一且经明确批准；
9. 只有实际通过的检查可以更新 Foundation Gate，不能按计划存在或测试数量推断完成。
10. 新建文档、增加章节或实质重写章节前必须读取父计划 §7.4；只对父计划 v1.1 于 2026-09-01 获项目所有者确认后的新增或实质修改内容增量适用，不追溯调整此前内容和已完成修改。

## 6. Phase 0：证据基线与执行映射

**目标：** 将 Accepted Target 输入转换为可执行、可审计且不预判结果的工作清单。

### Check Items

- [x] 为 CH-01..CH-14 逐项定位最小 production owner、现有测试、候选命令和观察边界；
- [x] 将每项当前证据标记为 Verified、Candidate、Contradicted 或 Missing；
- [x] 确认每项 disposition 为 Preserve、Characterize then replace 或 Baseline，不自行改变 Target 定义；
- [x] 为每项 CH 选择最低充分测试层和确定性控制；
- [x] 盘点现有测试命令、Vitest 配置、TypeScript/lint/build 能力和可复用 fixture；
- [x] 为 FT-01..FT-09 选择最小可执行机制，并记录为何现有工具足够或不足；
- [x] 定义 expected-failure fixture 的隔离位置，确保不会进入 production graph；
- [x] 定义 current violation inventory 字段；另为 Architecture Principle 临时例外定义 `Accepted` ADR、scope、reason、Owner、expiry date 和 removal condition；
- [x] 记录基线命令、环境版本、已知失败和非确定性风险；
- [x] 建立 CH/FT 到测试文件、命令和完成证据的追踪矩阵。

### Exit Gate

- [x] 23 个 canonical ID 均有唯一执行映射，没有重复编号或遗漏；
- [x] Current Fact Candidate 均需由代码/测试/运行证据确认后才进入断言；
- [x] 工具选择不要求修改生产架构或引入未经批准的依赖；
- [x] 项目所有者接受证据基线、执行批次和例外格式。

## 7. Phase 1：P0 Characterization

**目标：** 在任何相关 Architecture Slice 进入 Delivery 前，固定 CH-01..CH-10 的当前行为和已知差异。

### 执行批次

1. **请求与执行顺序：** CH-01、CH-02、CH-03；
2. **Hook、Fanout 与 Approval：** CH-04、CH-05、CH-06；
3. **Lifecycle、Shutdown 与 Abort：** CH-07、CH-08、CH-09；
4. **Subagent 基线：** CH-10。

批次只控制提交和复审大小，不创建新的行为 ID 或第二套优先级。

### Check Items

- [ ] 每项测试断言都链接 Phase 0 的当前证据和 Target disposition；
- [ ] queue、并发、Hook settlement、Fanout、approval wait、Abort 和 Shutdown 使用 barrier/fake 明确控制时序；
- [ ] Tool Call/Result、Event、Usage、caller result 和 cleanup 分别断言，不用单一 golden output 隐藏差异；
- [ ] `Characterize then replace` 的已知缺陷使用明确测试名称/注释标识迁移目标，不伪装为推荐契约；
- [ ] library/tool 两个 Subagent 入口均有可定位基线；
- [ ] 每个批次通过聚焦测试，并记录必要的相关回归命令。

### Exit Gate

- [ ] CH-01..CH-10 均有可重复自动化证据，或存在阻断 Phase 完成的明确 Missing Evidence；
- [ ] 测试没有改变生产行为、公共契约或已接受 Target Architecture；
- [ ] 独立复审无未解决 Critical/High；
- [ ] 项目所有者确认 P0 保护线和已知差异。

## 8. Phase 2：P1 Characterization

**目标：** 在 AF-04 关闭前补齐 CH-11..CH-14，并确认它们是否可升级为迁移不变量。

### Check Items

- [ ] CH-11 覆盖 Session history、compaction、孤立 Tool Use 修复和 Abort 后持久状态；
- [ ] CH-12 覆盖 startup success/failure、optional memory degradation 和已创建资源 cleanup；
- [ ] CH-13 覆盖 model missing/invalid、Provider failure、Usage/stream error 和 Provider call count；
- [ ] CH-14 覆盖 Prompt Tool definitions 派生现状与 memory 只依赖 tool name 的事实；
- [ ] Candidate 证据经代码/测试核验后才升级，冲突事实返回 Target/Architecture Review；
- [ ] P1 测试与 P0 保护线共同运行，未引入非确定性回归。

### Exit Gate

- [ ] CH-11..CH-14 均有可重复自动化证据和最终 disposition；
- [ ] 没有把偶然内部结构升级为公共承诺；
- [ ] 独立复审无未解决 Critical/High；
- [ ] 项目所有者确认完整 Characterization baseline。

## 9. Phase 3：Architecture Fitness Tests

**目标：** 自动化 FT-01..FT-09，并证明每条规则既能拦截最小违规，也不会把当前迁移状态伪装成目标完成。

### 执行批次

1. **依赖与 SDK 边界：** FT-01..FT-04；
2. **Extension、Provider 与 Registry 边界：** FT-05..FT-07；
3. **Contract 与文档治理：** FT-08..FT-09。

### Check Items

- [ ] 每条规则使用 Target Appendix A.2 的 canonical pass/fail 语义；
- [ ] 每条规则至少有一个隔离的 expected-failure fixture，并断言可定位诊断；
- [ ] production graph、test fixture graph、scripts 和 generated/third-party path 明确区分；
- [ ] 当前生产违规不会通过扩大永久 allowlist 隐藏；临时例外字段完整且可审计；
- [ ] FT-06 验证 change locality，不要求实现生产第二 Provider 或完整 External Extension；
- [ ] FT-08 的 Contract inventory 同时要求 success 与 failure/Abort/close 中至少一个适用负向场景；
- [ ] FT-09 只治理活跃文档和生产权威链接，不把历史记录误判为新实现依赖；
- [ ] 聚焦规则、完整 Fitness suite、lint 和 build 的命令及结果均被记录。

### Exit Gate

- [ ] FT-01..FT-09 均能对最小违规稳定失败，并对合法 fixture 稳定通过；
- [ ] 当前违规已通过测试失败或临时例外显式呈现；
- [ ] 没有新增通用 Service Locator、中央类型联合或测试专用生产架构；
- [ ] 独立复审无未解决 Critical/High；
- [ ] 项目所有者确认 Fitness 保护线和剩余例外。

## 10. Phase 4：Completion Record 与收口评审

**目标：** 汇总 AF-04 的实际证据、限制和 Gate 影响，不把测试存在等同于架构实现完成。

### Check Items

- [ ] 在本计划状态记录中列出实际命令、环境版本、测试/规则文件和结果；
- [ ] 完成 CH-01..CH-14、FT-01..FT-09 到测试、证据和 disposition 的最终矩阵；
- [ ] 记录通过、expected failure、当前违规、临时例外、非确定性控制和未覆盖风险；
- [ ] 只将经证据确认的事实同步到对应 Current Architecture 文档；
- [ ] 检查 AF-05/AF-06 输入是否因当前证据需要回到 Owner decision，不直接修改 Accepted Target；
- [ ] 执行聚焦测试、完整 Characterization/Fitness suite、lint、test 和 build；
- [ ] 执行独立架构/测试评审并逐项 triage finding；
- [ ] 项目所有者确认 Results、剩余风险和例外；
- [ ] 更新父计划、文档索引和本计划状态。

### Exit Gate

- [ ] 满足 §2.2 全部总体退出条件；
- [ ] Foundation Gate 只关闭已有执行证据支持的 Characterization/Fitness 条目；
- [ ] AF-05/AF-06 仍需 Accepted Spike Spec 和独立执行；
- [ ] 未授权任何生产 Architecture Slice 提前进入 Delivery。

## 11. 追踪框架

Target Architecture Appendix A 是 CH/FT 语义的唯一权威来源；本计划只管理执行状态，不复制行为定义。

| Work IDs | Priority / Type | Phase | 最低完成证据 |
|---|---|---:|---|
| CH-01..CH-10 | P0 Characterization | 1 | current evidence + deterministic test + disposition + command |
| CH-11..CH-14 | P1 Characterization | 2 | verified candidate + deterministic test + disposition + command |
| FT-01..FT-07 | Architecture boundary | 3 | pass fixture + expected-failure fixture + diagnostic + current status |
| FT-08 | Contract inventory | 3 | exported contract inventory + positive/negative coverage rule |
| FT-09 | Documentation governance | 3 | active/legacy fixtures + metadata/link diagnostic |

### 11.1 Phase 0 environment and command baseline

取证环境为 Windows、Node.js `v22.22.2`、Node ABI `127`、npm `10.9.7`。仓库使用一个 [Vitest 配置](../../vitest.config.ts)，测试位于 `src/**/*.test.ts`；`npm run lint` 执行 `tsc --noEmit`，`npm run build` 执行 `tsc`。当前没有 ESLint、独立 import-graph 工具或 type-test dependency。

| Command | 2026-08-31 baseline | Disposition |
|---|---|---|
| `npm run lint` | Pass | Phase 0 TypeScript baseline |
| `npm test -- src/core/memory/internal/sqlite-store.test.ts` | 1 file / 4 tests pass | Native `better-sqlite3` ABI verified in repository Node environment |
| `npm test` | 62 files / 651 tests pass | Pre-AF-04 regression baseline |

VS Code Test Runner 曾以 Node ABI `115` 加载 ABI `127` 的 `better-sqlite3`，导致同一 SQLite 文件 4 个环境失败；仓库 Node 22 终端复跑全部通过。该差异记录为 test-host environment risk，不是 production assertion failure。AF-04 的权威命令证据使用仓库声明的 Node 22 环境，并记录实际 Node/ABI；不能把扩展宿主 ABI 失败计入行为 baseline。

### 11.2 Owner decisions for Phase 0

项目所有者于 2026-08-31 确认：

1. FT-01 使用“最深稳定子目录”强分类；每个已配置目录只有一个边界，允许更深子目录覆盖；无法诚实强分类的现有路径进入 exact violation inventory，不按多数职责隐藏；
2. `docs/architecture/v1.0/**` 是 Historical / Legacy Candidate，不是新实现权威；生产源码把它作为规范来源时进入 FT-09 violation inventory；
3. pass/fail 小项目放在 `test-fixtures/architecture-fitness/**`，位于 `src` 和 production `tsconfig` graph 外；Vitest 只读取或以隔离配置编译；
4. 当前 FT 违规使用 exact baseline inventory：规则仍产生完整 diagnostics，测试锁定已确认集合；新增、消失或变化都要求 Review；这不是合规声明，也不是 Architecture Principle 临时例外。

### 11.3 CH-01..CH-14 execution mapping

`Verified` 表示代码、现有测试或可重复命令足以确认当前控制路径，不表示目标行为已实现或 AF-04 coverage 已完成。`Candidate` 表示已有部分证据，但完整行为断言仍缺关键观察。未发现需要将 Target disposition 改为 `Contradicted` 的条目。

| ID | Current owner / evidence anchor | Evidence | Coverage gap and deterministic control | Minimum test / command | Target disposition |
|---|---|---|---|---|---|
| CH-01 | `RuntimeApp` per-session queue / in-flight set；Batch 1 busy-session barrier test | Verified | 已验证同 Session queued request 串行、不同 Session 并行、queued 未启动时不调用 Runner；deferred Runner barrier + call counter | Runtime integration；`npm test -- src/runtime/RuntimeApp.test.ts -t "CH-01"` | Preserve Root request concurrency；steering 是当前 Turn 的 in-turn input，不属于 CH-01；Accepted Request/Snapshot 语义留给后续 Contract |
| CH-02 | `RuntimeApp` inbound `user_message`、`originMessageId`；Batch 1 runtime-to-real-Runner correlation tests | Verified | 已验证 runtime-generated message ID 贯穿 `user_message` -> `run_start`，并由同一 `turnId` 闭合 `run_end`；当前没有 Target `requestId` | Runtime/Channel integration；`npm test -- src/runtime/RuntimeApp.intake.test.ts src/core/runner/AgentRunner.test.ts -t "CH-02"` | Preserve user-message Fanout；目标 `requestId`/`turnId` 迁移另测 |
| CH-03 | `AgentRunner` Tool loop / `ToolExecutor`；Batch 1 deny、unknown/invalid、throw、Abort pairing tests | Verified | 已观察受控 Abort 在 Tool 间发生时丢失已完成真实结果，并在下一 Turn 将全部缺失 ID 统一 repair；fake LLM + executor + AbortController | Runner contract；`npm test -- src/core/runner/AgentRunner.test.ts -t "CH-03"` | Preserve pairing/context order；Characterize then replace 受控 Abort 的延迟通用 repair；目标方向由 [Accepted ADR-001](../architecture/adr-001-tool-result-closure-and-recovery.md) 约束，生产实现仍需 Accepted Module Spec 与独立 Slice；Slice 3 替换 Policy/Hook ownership |
| CH-04 | `runBeforeToolCall()` awaited；observer Hooks detached；Batch 2 deferred-barrier tests | Verified | 已验证 before Tool Hook 阻塞 Tool 执行，after Tool 与 compaction observer Hooks 不阻塞 Turn settlement；所有 barrier 在 teardown 前释放并等待完成 | Runner unit；`npm test -- src/core/runner/AgentRunner.test.ts -t "CH-04"` | Characterize then replace：Compaction observer 按 [ADR-002](../architecture/adr-002-context-budgeting-and-compaction-recovery.md) 在对应生命周期边界内 failure-isolated settlement；after Tool transformation/ordering 另由 Tool Hook Contract 冻结 |
| CH-05 | `RuntimeApp.create()` AgentEvent Fanout；Batch 2 multi-target failure tests | Verified | 已分别验证单个 `channel.send` 失败不影响其他 target 或 Turn，而 `onAgentEvent` 抛错会传播并阻止 Runner 启动 | Multi-target Runtime integration；`npm test -- src/runtime/RuntimeApp.test.ts -t "CH-05"` | Characterize then replace：目标每 target 隔离且不改变 Turn result |
| CH-06 | `resolveToolPolicy()` + `wireApprovalRouting()`；Batch 2 policy/runtime tests | Verified | 已验证 deny/allow/prompt matrix、无 capability fail-closed、capable origin 的隐藏固定 120 秒 timeout-deny routing，以及 approval Hook 仅在 `startChannels()` 后安装的 startup-history dependency | Policy unit + Runtime integration；`npm test -- src/runtime/tool-approval-policy.test.ts src/runtime/RuntimeApp.test.ts -t "CH-06"` | Preserve deny/allowlist fallback；改为 current-call capability；移除默认 120 秒 timeout-deny，目标 approval wait 为 response-or-abort |
| CH-07 | `RuntimeApp.startChannels()` / `stopChannels()` | Verified | 当前 partial start 无 rollback、flag 使 retry no-op；fake channels + start/stop counters + injected rejection | Runtime startup integration；`npm test -- src/runtime/RuntimeApp.test.ts -t "CH-07"` | Characterize then replace：creator rollback、atomic handoff、close-once |
| CH-08 | `RuntimeApp.close()`；现有 abort-before-wait/idempotent tests | Verified | 补 queued/approval wait、nonresponsive in-flight、Channel stop failure；deferred promises + test-side bounded race | Runtime shutdown integration；`npm test -- src/runtime/RuntimeApp.test.ts -t "CH-08"` | Characterize then replace：two-stage bounded Shutdown |
| CH-09 | `RuntimeApp.abortTurn()` + Runner Abort；现有 active/queue/cross-session tests | Verified | 通过 public Channel queue 补 active+queued、late steering 在 Turn 结束时的丢弃现状与 exactly-once observation；barrier + event recorder | Runtime integration；`npm test -- src/runtime/RuntimeApp.test.ts -t "CH-09"` | Preserve public Abort/queue semantics；目标补 exactly-once completion；late-steering disposition 待该批次确认 |
| CH-10 | Task Tool、library `runSubagentTurn()`、`SubagentRunner`；现有 outcome/event/Abort tests | Verified | 补 RuntimeApp library path、Usage/Event/route/session cleanup；fake child runner + cleanup counters | Tool + library Subagent contract；`npm test -- src/runtime/subagent-orchestration.test.ts -t "CH-10"` | Preserve blocking baseline；Slice 2 统一 tracked Child path |
| CH-11 | `SessionManager`/transcript + Runner compaction/orphan repair；现有 persistence tests | Verified | 将 history、compaction、orphan repair、Abort persistence 组合为可定位 baseline；temp directory + fake LLM | Runner/Session integration；`npm test -- src/core/runner/AgentRunner.test.ts -t "CH-11"` | Characterize current behavior；Tool closure 目标由 [ADR-001](../architecture/adr-001-tool-result-closure-and-recovery.md) 约束，Context Budgeting/Compaction Recovery 目标由 [ADR-002](../architecture/adr-002-context-budgeting-and-compaction-recovery.md) 约束 |
| CH-12 | `bootstrapRuntime()` + Runtime close；现有 memory degradation test | Verified | 当前 later bootstrap failure 不 cleanup earlier resources；injected failure + close counters + temp directory | Bootstrap integration；`npm test -- src/runtime/RuntimeApp.test.ts -t "CH-12"` | Baseline success/degradation；replace incomplete rollback |
| CH-13 | `RuntimeApp.requireModel()` + Runner stream failure/Usage | Candidate | missing model 可 pre-call fail；invalid model 当前无独立本地校验；provider call counter + fake stream error | Runtime/Provider fake contract；`npm test -- src/core/runner/AgentRunner.test.ts -t "CH-13"` | Baseline current mapping；Slice 1 保持 pre-call/fail-closed |
| CH-14 | `tool-registry` -> `prompt-factory` -> `SystemPromptBuilder` | Verified | 补 full-mode complete definitions 不渲染；确认 memory 只看 tool name | Prompt unit + Tool projection contract；`npm test -- src/core/prompt/SystemPromptBuilder.test.ts -t "CH-14"` | Baseline mechanical path；Slice 3 删除重复转换并保持 memory 行为 |

CH-05、CH-07、CH-12 和 CH-13 的现状是 Characterization 输入，不是待 AF-04 内修复的 Defect：observer throw 可传播、partial Channel start 无 rollback 且阻断 retry、bootstrap partial failure 无 cleanup、invalid model 没有独立本地 classification。实现测试时必须用明确名称记录这些差异；生产修复需另行分类和批准。

### 11.4 FT-01 directory boundary policy

FT-01 扫描 production `src/**/*.ts`，排除 `*.test.ts`、`src/test-setup.ts`、`test-fixtures/**`、`dist/**`、`node_modules/**` 和生成物。排除只描述非 production graph，不能用于隐藏生产违规。

| Configured path | Boundary | Notes |
|---|---|---|
| `src/core/runner/**` | Application / Turn Execution | Stable Core；当前外层 import 进入 violation inventory |
| `src/core/prompt/**` | Application | Stable Core |
| `src/core/subagent/**` | Application / Subagent Orchestration | Stable Core |
| `src/core/tools/**` | Domain Contract + Application Tool Execution | Stable Core default |
| `src/core/tools/builtin/**` | Infrastructure / Bundled Runtime Module | 最深子目录覆盖 |
| `src/core/memory/**` | Application Port / Policy | Stable Core default |
| `src/core/memory/internal/**` | Infrastructure Store / Index | 最深子目录覆盖 |
| `src/adapters/**` | Infrastructure Integration | Provider/Channel Adapter |
| `src/platform/config/**` | Composition / Configuration Input | 外层配置加载与校验 |
| `src/runtime/**` | Mixed current path | `RuntimeApp.ts` 的 Application 与 `bootstrap.ts` 的 Composition 共存；全部现有文件进入 mixed-path inventory，新增文件不得静默继承主责 |
| `src/core/session/**` | Mixed current path | Session Domain/Application 与 JSONL/I/O Store 共存 |
| `src/core/workspace/**` | Mixed current path | Application use case 与 filesystem adapter 共存 |
| `src/core/media/**` | Mixed current path | Application Media Processing 与 Infrastructure Image Adapter 共存；Target v1.1 已定义逻辑所有权 |
| `src/platform/logger/**` | Mixed current path | `types.ts` 是 Application-owned Observability Port candidate；`Logger.ts`/Console/File 是当前 Infrastructure/Legacy implementation |

规则必须要求每个 production file 命中一个 configured stable root 或 exact mixed-path inventory。新增未分类文件失败；mixed inventory 的条目变化触发 Review。该机制保留“整目录强分类”的确定性，同时不把 Accepted Target 已确认的混合所有权伪装成单一边界。

#### 11.4.1 Exact mixed/unmapped production path inventory

以下只列 production `.ts`；同目录 `*.test.ts` 不属于 production graph。每个路径必须 exact match，不能用目录 glob 把未来新文件自动纳入 baseline。

| Status | Exact production paths | Current semantic conflict |
|---|---|---|
| Mixed | `src/runtime/bootstrap.ts`、`errors.ts`、`glob-match.ts`、`index.ts`、`prompt-factory.ts`、`queue-types.ts`、`RuntimeApp.ts`、`subagent-orchestration.ts`、`summarize-assembled.ts`、`tool-approval-policy.ts`、`tool-registry.ts`、`types.ts` | Composition、Runtime Application、Policy、Contract 和 current assembly 共存 |
| Mixed | `src/core/session/index.ts`、`lock.ts`、`SessionManager.ts`、`store.ts`、`transcript.ts`、`types.ts` | Session Domain/Application、serialization 和 filesystem-backed Store 共存 |
| Mixed | `src/core/workspace/index.ts`、`init.ts`、`loader.ts`、`types.ts` | Workspace use case、Contract 和 filesystem adapter 共存 |
| Mixed | `src/core/media/attachment-pipeline.ts`、`constants.ts`、`image-metadata.ts`、`image-optimize.ts`、`index.ts` | Application media policy/normalization、pure metadata、Adapter-owned block types、WebSocket limit 和 concrete `sharp` processing 共存 |
| Mixed | `src/platform/logger/ConsoleAdapter.ts`、`FileAdapter.ts`、`index.ts`、`Logger.ts`、`types.ts` | Observability Port candidate、global Logger state 和 concrete adapters 共存 |

文件名未带完整目录时继承同一单元格首个路径的目录。Phase 3 实现应把上表展开为完整 normalized repository-relative paths 后比较；报告必须输出新增、删除或变更的 exact path，不接受 wildcard baseline。

### 11.5 FT-01..FT-09 execution mapping

现有 `typescript` compiler API、Vitest 和 Node `fs/path` 足以实现全部规则，不新增 dependency。共享实现最多包含 production import graph/path classification、隔离 fixture project 和 structured Markdown status/link reader；不建设通用依赖分析平台。

| ID | Production/doc scope | Current status | Minimum mechanism and fixture | Required diagnostic / command |
|---|---|---|---|---|
| FT-01 | §11.4 configured production roots | Current violations + mixed paths | TS import graph；pass: Stable Core -> core-owned Port；fail: Runner -> `runtime/bootstrap` | rule/source+boundary/import/target+boundary；`npm test -- src/architecture-fitness/ft-01-boundaries.test.ts` |
| FT-02 | Provider/Channel SDK imports in production `src` | Compliant：Anthropic SDK/WebSocket package 只在对应 Adapter | AST package scan；pass Adapter import；fail RuntimeApp import SDK | rule/package/source/allowed roots；`npm test -- src/architecture-fitness/ft-02-sdk-allowlist.test.ts` |
| FT-03 | `src/core/runner/**` imports、constructor/exported run inputs | Current violations：adapter LLM types、platform config/logger；Target inputs 尚不存在 | AST import/public-boundary scan；pass synthetic explicit input；fail `loadConfig()`/mutable Registry | rule/source/symbol/violation kind；`npm test -- src/architecture-fitness/ft-03-runner-boundary.test.ts` |
| FT-04 | 明确配置的 future New Authoritative Core roots -> Compat/Legacy | Not applicable；当前无 new-core/compat/legacy production roots | Path denylist；pass Compat -> New Core；fail Resolver -> legacy config adapter | rule/source/forbidden target；`npm test -- src/architecture-fitness/ft-04-legacy-direction.test.ts` |
| FT-05 | future Extension/Runtime Module roots | Not applicable；当前无 Extension Framework，未发现 generic Service Locator | AST import/call scan；pass typed capability；fail Extension -> RuntimeApp / `services.get()` | rule/source/symbol/capability；`npm test -- src/architecture-fitness/ft-05-extension-capability.test.ts` |
| FT-06 | synthetic second Provider/cross-contribution Extension change locality | Not applicable to production；中央 assembly 是 migration input | fixture manifest + forbidden identity/branch scan；pass only fixture Contract；fail core branch on fixture ID | rule/fixture ID/core file/matched branch；`npm test -- src/architecture-fitness/ft-06-change-locality.test.ts` |
| FT-07 | future Registry Snapshot consumer boundary | Not applicable to Target API；current mutable `RuntimeToolBundle` 是 migration input | isolated TS compile；pass readonly projection rejects mutation；fail mutable Registry/Builder consumer | rule/source/type/mutable member；`npm test -- src/architecture-fitness/ft-07-registry-snapshot.test.ts` |
| FT-08 | explicitly inventoried exported Event/Error/Port/Lifecycle Contracts | Unknown/incomplete inventory；已有部分 success/failure/Abort/close tests | small TS/JSON inventory + export/test reference check；fail exported Lifecycle Contract without negative case | rule/export/source/missing positive-or-negative test；`npm test -- src/architecture-fitness/ft-08-contract-inventory.test.ts` |
| FT-09 | active architecture/ADR/spec/plan metadata and normative Legacy links | Current violation candidates；`v1.0/**` 为 Historical/Legacy Candidate | structured Markdown status/link parser；pass active status + no Legacy authority；fail missing status/normative Legacy link | rule/doc/category/field-or-link；`npm test -- src/architecture-fitness/ft-09-doc-governance.test.ts` |

### 11.6 Current violation inventory baseline

此表只记录 Phase 0 已确认候选；Phase 3 的 executable diagnostics 是增删条目的权威证据。`Suggested owner/slice` 不是 ADR 例外、实施授权或最终文件移动方案。

| Rule | Actual edge / fact | Evidence | Suggested semantic owner / expiry work |
|---|---|---|---|
| FT-01 / FT-03 | Runner imports adapter LLM types and platform config/logger types | `src/core/runner/AgentRunner.ts`、`src/core/runner/types.ts`、context helpers | Turn Execution / Model Resolution；Slice 1/2 Contract migration |
| FT-01 / FT-03 | RuntimeApp imports bootstrap and concrete adapter-owned types，且向 Runner 传递 raw model/config-derived values | `src/runtime/RuntimeApp.ts` | Runtime Application / Runtime Composition；Slice 1/5 |
| FT-01 | §11.4.1 的 `runtime`、`core/session`、`core/workspace`、`core/media`、`platform/logger` 是 exact mixed paths | Target §4.5 + Phase 0 source layout | 对应 Target semantic owners；相关 Slice 建立真实边界时删除 exact inventory |
| FT-07 | mutable `RuntimeToolBundle` 被 `RuntimeResourceSet` 保存并在 RuntimeApp post-bootstrap replacement | `src/runtime/types.ts`、`src/runtime/RuntimeApp.ts` | Registry / Runtime Builder；Slice 3/5 |
| FT-08 | exported Contract inventory 尚未建立，不能证明全部 success + negative coverage | current barrels/types and existing tests | Contract owners；AF-04 Phase 3 建立 inventory |
| FT-09 | active-looking architecture docs 缺统一状态；production comments 把 `docs/architecture/v1.0/**` 当规范来源 | `docs/architecture/*.md`、config wizard source comments | Documentation Governance；AF-04 FT-09 + Slice 6 |

Phase 0 不为上述违规申请 ADR 例外。Phase 3 production scan 必须输出 exact diagnostics，并将其与 baseline inventory 比较；只有新增、消失或内容变化触发失败/Review，已知集合本身以显式 baseline 通过，直到单独批准的工作删除对应违规。

### 11.7 Non-determinism and evidence risks

| Risk | Phase 0 control |
|---|---|
| Hook、queue、Shutdown 测试依赖 wall-clock sleep | 使用 deferred promise/barrier；只有 approval expiry 等真实时间语义使用 fake clock |
| nonresponsive Shutdown characterization 挂住 suite | 使用 test-side bounded race 证明 `close()` 仍 pending，再显式释放 fake；不扩大 production timeout |
| Native module ABI 随 test host 漂移 | 记录 Node/ABI；权威命令使用仓库 Node 22 终端 |
| Temp filesystem / JSONL / bootstrap state 泄漏 | 每测试独立 temp dir + `finally` cleanup；全局 Logger/Runtime lifecycle 显式 reset/close |
| expected-failure fixture 污染 production compile | 固定在 `test-fixtures/architecture-fitness/**`，不进入 root `tsconfig.include` |
| Markdown prose parser 脆弱 | 只解析 status block、已配置 category 和 Markdown links，不推断任意自然语言语义 |
| exact violation baseline 变成永久 allowlist | diagnostic 全量保留；集合任何变化失败并 Review；对应 Slice 删除后同步收紧 baseline |

## 12. 停止与升级条件

出现以下任一情况时暂停当前 Phase，并进入 Owner/Architecture Review：

- 测试证据否定 Accepted Target Architecture、Architecture Principle 或既定 migration disposition；
- 必须改变生产行为、公共契约、导出或依赖方向才能观察当前行为；
- 必须通过私有生产重构才能获得确定性测试边界，且尚未按 Small Change/Defect 单独确认范围和验证；
- 必须新增外部依赖、通用框架或仓库级重构才能实现 Fitness rule；
- 并发、Abort、Shutdown 或 I/O 测试只能靠扩大 timeout 或非确定性重试通过；
- Current Fact Candidate 与代码/现有测试冲突，且会改变后续 Slice 顺序或验收；
- expected-failure fixture 无法稳定触发规则，或合法 fixture 被误报；
- Accepted Architecture Principle 的临时例外无法通过 `Accepted` ADR 给出 scope、reason、唯一 Owner、expiry date 和可验证 removal condition；
- AF-04 范围开始实质执行 AF-05/AF-06 Hypothesis 或生产 Architecture Slice。

Review 必须选择：缩小断言、改进 test fixture、登记有期限例外、单独提出 Defect/Spec/Spike、修订 Accepted Architecture，或暂停 AF-04。不得通过弱化规则或静默改生产行为绕过。

## 13. 产物

AF-04 完成时至少产生：

1. 本执行计划和逐 Phase 状态记录；
2. CH-01..CH-14 Characterization Tests；
3. FT-01..FT-09 executable rules 与隔离 expected-failure fixtures；
4. 当前违规/临时例外登记；
5. 实际命令、环境、映射、结果和残余风险组成的 AF-04 Completion Record；
6. 经证据升级的 Current Architecture 更新；
7. 独立评审记录、父计划和文档索引同步。

不为没有独立生命周期的信息创建额外碎片文档；Completion Record 默认保留在本计划状态记录和最终矩阵中。若证据量超过可审计范围，再由项目所有者批准拆分独立 evidence artifact。

## 14. 状态记录

| Phase | 状态 | 完成日期 | 证据/备注 |
|---|---|---|---|
| Phase 0：证据基线与执行映射 | Completed | 2026-08-31 | 项目所有者接受 evidence baseline、implementation batches 与 exception format；独立复审为 Critical/High/Medium/Low 0/0/0/0，blocking-overdesign 0；尚未授权 Phase 1、测试实现或生产代码变更 |
| Phase 1：P0 Characterization | In Progress |  | 项目所有者于 2026-09-01 接受 Batch 1（CH-01、CH-02、CH-03）；Batch 2（CH-04、CH-05、CH-06）test-only implementation、验证和独立复审已完成；CH-06 migration disposition 已确认，CH-04/CH-05 Owner disposition 仍待确认；未授权 Batch 3 或生产代码变更 |
| Phase 2：P1 Characterization | Not Started |  |  |
| Phase 3：Architecture Fitness Tests | Not Started |  |  |
| Phase 4：Completion Record 与收口评审 | Not Started |  |  |

### Phase 1 Batch 1 evidence

| Scope | Command | Result |
|---|---|---|
| CH-01 | `npm test -- src/runtime/RuntimeApp.test.ts -t "CH-01"` | Pass；1 test |
| CH-01 post-review cleanup | VS Code Test Runner：`CH-01 serializes a busy session while another session runs concurrently` | Pass；1 test；仅使用 Runner 调用顺序与公开 runtime state |
| CH-02、CH-03 | `npm test -- src/runtime/RuntimeApp.intake.test.ts src/core/runner/AgentRunner.test.ts -t "CH-02\|CH-03"` | Pass；8 tests |
| Post-acceptance focused revalidation | VS Code Test Runner：2 个 CH-02 correlation tests；`npm test -- src/core/runner/AgentRunner.test.ts -t "CH-03"` | Pass；CH-02 2 tests，CH-03 5 tests |
| Related regression | `npm test -- src/runtime/RuntimeApp.test.ts src/runtime/RuntimeApp.intake.test.ts src/core/runner/AgentRunner.test.ts` | Pass；78 tests |
| TypeScript baseline | `npm run lint` | Pass；exit 0 |
| Patch hygiene | `git diff --check` | Pass；exit 0 |

Batch 1 没有修改 production code、公共契约或 Accepted Target Architecture。独立复审累计关闭 4 个 Medium 与 2 个 Low finding；最终复审结果为 Critical/High/Medium/Low `0/0/0/0`，blocking-overdesign `0`。最后两个 Medium 分别通过修正已实现 Abort 概述和将 CH-02 evidence 同步为 `Verified` 关闭。CH-01 post-review cleanup 已删除对 private `activeAborts` 的读取，未为测试引入 production seam。

### Phase 1 Batch 1 Owner dispositions

项目所有者于 2026-09-01 接受 CH-01 queued concurrency baseline：同一 Session 的 Root request 串行、不同 Session 可并行，queued request 未开始时不调用 Runner。Steering 注入当前活动 Turn，不创建 Root Turn，因此不属于 CH-01；late steering 在最后 drain 后可能随 Turn cleanup 丢弃的现状留给 CH-09 批次 characterization 和 disposition，不阻断 Batch 1 接受。

项目所有者于 2026-09-01 接受 CH-03 characterization disposition，并接受 [ADR-001](../architecture/adr-001-tool-result-closure-and-recovery.md) 作为以下迁移边界的目标架构权威：

1. 完整持久化的 `tool_use` 必须最终由同 ID 的 `tool_result` 闭合；现有 next-turn `repairOrphanToolUses()` 保留为 crash、存储失败和旧历史损坏的结构恢复兜底；
2. 受控 Abort 不应依赖下一 Turn repair：已完成 Tool 保留真实结果，确认取消的 Tool 写 aborted result，未启动的 Tool 写 not-executed result；不响应 AbortSignal 且已启动的 Tool 等待结束并保留真实结果；
3. crash 或其他非 Abort 缺口无法证明 Tool 是否执行，repair 只能写 outcome-unknown error；恢复层不隐式续跑或重放旧 Turn，后续行为由新 Turn 重新规划。

当前 CH-03 测试准确记录“受控 Abort 可留下 orphan，并在下一 Turn 将已完成与未启动 Tool 统一 repair”的现状，因此作为 Characterization baseline 保留；该行为标记为 `Characterize then replace`，不是目标契约。生产修复必须等待 Accepted Module Spec 和单独批准的 Defect 或 Architecture Slice。Batch 1 的接受不授权 Phase 1 Batch 2。

### Phase 1 Batch 2 evidence

| Scope | Command | Result |
|---|---|---|
| CH-04 | VS Code Test Runner：3 个 `CH-04` tests | Pass；3 tests；deferred barrier，无 timeout tick |
| CH-05 | VS Code Test Runner：`CH-04`、`CH-05` | Pass；5 tests，其中 CH-05 2 tests |
| CH-06 | VS Code Test Runner：`CH-06` | Pass；15 tests |
| Related regression | VS Code Test Runner：`AgentRunner.test.ts`、`RuntimeApp.test.ts`、`tool-approval-policy.test.ts` | Pass；80 tests |
| TypeScript baseline | `npm run lint` | Pass；exit 0 |
| Patch hygiene | `git diff --check` | Pass；exit 0 |

Batch 2 只修改 Characterization Tests，没有修改 production code、公共 Contract 或 Accepted Target Architecture，也没有新增 dependency 或 production test seam。独立复审累计关闭 2 个 Medium 与 1 个 Low finding：拆分 CH-05 两类 failure observation、等待 CH-04 detached callback cleanup，并将 CH-06 timeout decision 断言移到测试主体且等待 queued Runner Promise。最终复审结果为 Critical/High/Medium/Low `0/0/0/0`，blocking-overdesign `0`。

### Phase 1 Batch 2 Owner disposition

Partial。项目所有者于 2026-09-01 确认 CH-06 的 Characterization 与 migration disposition：现有 deny/allow/prompt matrix、无 capability fail-closed、`startChannels()` startup-history dependency 和 capable origin 的隐藏固定 120 秒 timeout-deny 均作为迁移前事实保留；目标移除默认 120 秒 timeout-deny，人工 approval 采用 response-or-abort，并观察 Turn Abort、Shutdown 和当前调用 capability 可用性。未来 `Allow all`、`Always allow` 或其他持久/会话级授权机制暂不讨论，不属于本 disposition。

CH-04 detached observer Hooks 与 CH-05 `onAgentEvent` failure propagation 的 Owner disposition 仍为 Pending，因此 Batch 2 整体尚未接受；本节不授权 Phase 1 Batch 3 或生产代码变更。CH-06 生产迁移必须先有 Accepted Module Spec，并作为独立 Architecture Slice 获得 Delivery 批准。

项目所有者于 2026-09-01 接受 [Approval Lifecycle Module Spec](../architecture/approval-lifecycle-spec.md) v0.1，并单独批准 CH-06 Approval Lifecycle Architecture Slice 进入 Delivery。该授权只覆盖移除默认 120 秒 timeout-deny、接入 response-or-abort 生命周期及所需 Channel/client/test 迁移；不接受 CH-04/CH-05 disposition，不授权 Phase 1 Batch 3，也不包含 `Allow all`、`Always allow` 或其他持久/会话级授权机制。