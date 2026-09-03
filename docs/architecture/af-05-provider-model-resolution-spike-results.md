# AF-05 Provider/Model Resolution Spike Results

## 1. 记录

- **Spike 状态：** Completed
- **结果：** Provisional Pass（项目所有者已接受）
- **执行日期：** 2026-09-03
- **接受与清理日期：** 2026-09-03
- **时间盒证据：** 开始与结束均为 2026-09-03；实际执行小于 1 个工作日，未达到 2 个工作日硬停止
- **所有者：** 项目所有者
- **执行环境：** Windows；Node.js `v22.22.2`；Node ABI `127`；npm `10.9.7`；TypeScript `5.9.3`；Vitest `3.2.4`
- **执行基线：** commit `359e17f603e4db2096242739c1168d186fc150de`；branch `feature/refactoring`
- **Spike Spec：** [AF-05 Provider/Model Resolution Spike Spec](af-05-provider-model-resolution-spike-spec.md)（`Accepted`，2026-09-03）
- **父计划与语言约定：** [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)
- **权威目标：** [Target Architecture §5](target-architecture.md#5-provider-and-model-resolution)
- **相关约束：** [Architecture Principles](architecture-principles.md)、[Domain Glossary](domain-glossary.md)、[ADR-002](adr-002-context-budgeting-and-compaction-recovery.md)
- **工作流：** [Development Workflow](../development-workflow.md)

本 Results 记录 disposable AF-05 Spike 的实际证据。项目所有者于 2026-09-03 接受 `Provisional Pass`；随后已删除全部 disposable fixture 并完成 cleanup validation，因此 Spike 状态为 `Completed`。该接受不接受 production design、不冻结 TypeScript API，也不授权 AF-06、AF-07、Slice 1 或生产迁移。

## 2. 接受时的假设

### AF05-H01

可以。current Anthropic Adapter 的 fake-transport execution、一个 independent Fake Provider、单向 Legacy Compatibility Adapter、Parent/Child 不同 Model、Provider 内 Facts 合并、受控资源共享和 overflow correction 可以全部在 production graph 外验证，同时满足：

1. Runner 不读取 Config、不选择 Provider、不推断 Model Facts，也不出现 Provider identity branch；
2. 每个 Turn 只观察一个原子绑定且不可变的 Resolved Model；
3. Provider/Model 切换同步切换 Port binding、Protocol、Endpoint、Capability facts 和请求限制；
4. Parent 与 Child 独立解析，不共享 Resolved Model 或 per-turn 可变请求状态；
5. 所有不可解析或不允许的输入在 Model Invocation 前 fail closed；
6. Provider 内来源合并保留 provenance，fallback 只补缺，overflow observation 只收紧；
7. Provider 不接管 Compaction、Session persistence 或 Runner retry ownership。

## 3. 执行范围

实验执行时只新增于 `test-fixtures/architecture-spikes/af-05/**`；这些 disposable 文件已在 Results 获接受后全部删除：

- `new-core/model-resolution.ts`：disposable target-shaped Resolver、Resolved Model 和分类失败；
- `new-core/overflow-coordinator.ts`：P2-E08 的一次 correction、一次 Session-owned Compaction 请求和一次 bounded retry；
- `compat/legacy-llm-config-adapter.ts`：只允许 `Compatibility -> New Core` 的旧静态配置映射；
- `providers/provider-bindings.ts`：current Anthropic Adapter 包装、independent Fake Provider、Provider-owned facts merge、resource lease 和 overflow observation；
- `support/import-graph.ts`：fixture-local transitive import graph；
- `af-05-provider-model-resolution.spike.ts`：按 `P2-E01..P2-E08` 排列的单一 evidence suite；
- fixture-local TypeScript 与 Vitest config：使 Spike 不进入 production build 和 root regression discovery。

没有修改 production source、production test seam、公共 Contract、dependency、package metadata 或 lockfile。没有读取 secret、访问网络、发起 paid probe 或写 production workspace/session data。

## 4. 执行步骤与命令

### 4.1 首个可证伪场景

```text
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-05/tsconfig.json
npx vitest run --config test-fixtures/architecture-spikes/af-05/vitest.config.ts -t "P2-E01"
npx vitest run --config test-fixtures/architecture-spikes/af-05/vitest.config.ts -t "P2-E08"
```

结果：TypeScript 无 diagnostics；`P2-E01` 为 1 file / 2 passed / 8 skipped；`P2-E08` 为 1 file / 2 passed / 8 skipped。

### 4.2 首次完整矩阵与方法偏差

首次完整矩阵为 9 passed / 1 failed。`P2-E05` 在两个 concurrent `createSession()` 写入同一临时 Session store 时出现 `SyntaxError: Unexpected end of JSON input`。该失败发生在 Provider lease overlap 之前，不是 AF05-H01 的反例，也未命中 Stop Condition。

最小修正是先顺序创建两个 OS-temporary Session，再开始受控重叠；这与 Accepted Spec 允许的临时真实 `SessionManager` fixture 一致。修正后聚焦 `P2-E05` 为 1 passed / 9 skipped。没有修改 Session production code、放宽 timeout 或增加 retry。

独立复审随后发现 evidence assertions 不足，而不是 architecture failure：P2-E02 缺 Capability observation；P2-E03 最初只覆盖四类来源的 24 个顺序，没有把 observation 纳入排列；P2-E05 未在 overlap 中 Abort 且缺 `model: inherit`；P2-E06 policy/reference replacement 不可区分；P2-E07 counters 部分不可执行；P2-E08 缺真实 next-Turn resolution 和 retry exhaustion。以上均以同一 disposable fixture 内的最小 assertion/instrumentation 修正，没有改变 Accepted Hypothesis、production code 或 scenario IDs。P2-E03 最终对 tightening 与 non-tightening observation 两个反例分别执行全部 $5! = 120$ 个来源顺序。

### 4.3 最终 Spike 证据

```text
npx vitest run --config test-fixtures/architecture-spikes/af-05/vitest.config.ts
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-05/tsconfig.json
```

最终结果：

- Spike suite：1 file / 10 tests passed；`P2-E01..P2-E08` 全部通过；3.75s；
- fixture TypeScript：通过，无 diagnostics；
- network sentinel：0 calls；
- paid-probe sentinel：0 calls；
- root `npm test` 未发现 `.spike.ts` fixture。

### 4.4 AF-04 保护线

```text
npm test -- src/runtime/RuntimeApp.test.ts src/core/runner/AgentRunner.test.ts -t "CH-13"
npm test -- src/architecture-fitness/ft-01-boundaries.test.ts src/architecture-fitness/ft-02-sdk-allowlist.test.ts src/architecture-fitness/ft-03-runner-boundary.test.ts src/architecture-fitness/ft-04-legacy-direction.test.ts src/architecture-fitness/ft-06-change-locality.test.ts
```

结果：

- CH-13：2 files passed；3 passed / 72 skipped；
- Fitness protection：5 files / 10 tests passed。

### 4.5 Repository 收口检查

```text
npm run lint
npm test
npm run build
git diff --check
```

结果：全部通过；root regression 为 72 files / 695 tests passed，且未发现 AF-05 `.spike.ts` fixture。

第一次批量调用这些命令时，执行环境在 npm/Git 启动前返回 Windows `ENOENT`/usage error；显式确认工作目录为 repository root 后，四条相同命令全部通过。该启动失败未执行 lint、test 或 build，也不是 repository failure。

### 4.6 接受后清理验证

项目所有者接受 Results 后，按 Spec §13 删除 `test-fixtures/architecture-spikes/af-05/**` 全部 8 个文件及其空目录；路径检查确认整个 AF-05 disposable directory tree 已不存在，Architecture Fitness fixture 保持存在。随后执行 `npm run lint`、`npm test`、`npm run build` 和 `git diff --check`。

首次 cleanup `npm test` 在未修改工作树的情况下报告 70/72 files、692/695 tests passed，但执行记录未返回可定位的失败详情，因此没有据此修改代码。随后两次未修改工作树的完整回归连续通过，均为 72 files / 695 tests passed，耗时分别为 13.00s 和 12.07s。lint、build、`git diff --check` 全部通过；package metadata 与 lockfiles 无变更。cleanup 完成后才将本 Spike 晋升为 `Completed`。

## 5. 规范证据

执行时精确 test locator 为 `test-fixtures/architecture-spikes/af-05/af-05-provider-model-resolution.spike.ts`。单一 suite 按八个 canonical `describe` group 排列；`P2-E01` 与 `P2-E08` 各含两个 test，其余各含一个，共 10 tests。该 locator 随接受后的 mandatory disposable cleanup 一并删除；本节及 §5.1–§5.3 保留其结果矩阵。

| ID | 实际观察 | 结果 |
|---|---|---|
| `P2-E01` | current `AnthropicClient` 在 hoisted fake SDK transport 下完成真实 adapter stream normalization；independent Fake Provider 通过同一 unchanged `AgentRunner` 路径运行；Legacy/native 输入产生等价 Resolved Model；`Compatibility -> New Core` edge 存在，New Core 到 Compatibility 的 transitive path count 为 0 | Pass |
| `P2-E02` | 按 A -> B -> A -> B 重复切换；每次 Provider/Model identity、Port object、Protocol、Endpoint、context limit、max output、Tool Use capability/provenance 和输出均来自同一候选 | Pass |
| `P2-E03` | 预先冻结 precedence；deployment override、Provider metadata、static catalog、provider-default、observation correction 五类来源，在 tightening 与 non-tightening 两个反例中分别执行全部 120 个排列并产生预期 winner；normal conflict、fallback ignored/selected、observation tighten/non-tighten diagnostics 可观察；fallback 只补缺，observation 只收紧 | Pass |
| `P2-E04` | trusted `200000` 为 `provider-metadata`；unknown model 的相同数值为 `provider-default`；缺少 Tool Use Fact 的请求返回 `capability_unsupported`，SDK call count 不增加；disposable Resolver 无 Core default | Pass |
| `P2-E05` | Parent/Child 在同一 read-only resource owner 下同时持有两个 lease；overlap 中 Abort Parent 后 Parent 归一化为 `aborted`/zero Usage，Child 正常完成且 Usage/Event/signal 不串扰；每个 acquisition 与 release 配对；resource 只允许关闭一次；`model: inherit` 使用 Parent effective Reference 重新生成不同 Resolved Model | Pass |
| `P2-E06` | old Turn 已进入旧 Port 后替换 fixture-owned Binding/Catalog、Config/Connection、Policy 和 Model Reference；新 Policy 可区分地拒绝旧 Reference；old Turn 继续使用旧 Port/Endpoint/Facts，new Turn 使用新 identity/Port/Endpoint/Facts | Pass |
| `P2-E07` | 12 类输入覆盖 Provider 未注册、Connection 缺失/无效、Reference malformed/Provider rejected/unknown locally rejected、identity ambiguity、Facts 不足、Policy deny、越权 Override、Protocol mismatch 和 Capability unsupported；每项 local resolution count 符合阶段预期，Invocation Port、Anthropic SDK stream、network 和 paid-probe counts 均为 0 | Pass |
| `P2-E08` | exact/conservative correction 各覆盖 Turn-local 与 retained mode；Provider 从 Resolved Model identity/Endpoint/Model 派生 observation key；fresh same-key Turn 仅在 retained mode 得到 `observed-conservative` fact，different-key Turn 保持 static fact；no-detail 不猜 correction 但请求一次 Compaction；第二次 overflow 向上返回，恰好两次 invocation、一次 Compaction；原 Resolved Model 始终不变 | Pass |

### 5.1 P2-E03 冻结的 precedence

下表在冲突注入和观察前固定；测试没有根据结果回改 winner。

| 冲突 case | 预期 winner | 实际结果 |
|---|---|---|
| applicable deployment override vs Provider metadata/static catalog | deployment override | Pass；全部排列一致 |
| Provider metadata vs static catalog | Provider metadata | Pass；全部排列一致 |
| applicable normal source vs Provider fallback | normal source | Pass；fallback 只补缺 |
| prior effective limit vs stricter observation | stricter observation | Pass；provenance 为 `observed-conservative` |
| prior effective limit vs looser observation | prior effective limit | Pass；产生 non-tightening diagnostic |

本实验只对 `effectiveContextLimit` 执行冲突来源合并。`maxOutputTokens` 与 Tool Use Capability 只验证 sourced transport、原子绑定和 fail-closed，不据此推广其最终 precedence。

### 5.2 P2-E07 分类与计数

| 输入 | Resolution Failure | 允许的 local Provider resolution calls | Invocation / SDK stream / network / paid probe |
|---|---|---:|---|
| Provider 未注册 | `provider_unregistered` | 0 | `0 / 0 / 0 / 0` |
| Connection 缺失 | `connection_missing` | 0 | `0 / 0 / 0 / 0` |
| Connection 无效 | `connection_invalid` | 0 | `0 / 0 / 0 / 0` |
| Model Reference malformed | `reference_invalid` | 0 | `0 / 0 / 0 / 0` |
| Provider 拒绝 Reference | `model_rejected` | 1 | `0 / 0 / 0 / 0` |
| unknown model 本地拒绝 | `model_rejected` | 1 | `0 / 0 / 0 / 0` |
| Model identity 歧义 | `model_ambiguous` | 1 | `0 / 0 / 0 / 0` |
| 关键 Facts 不足 | `facts_insufficient` | 1 | `0 / 0 / 0 / 0` |
| Policy deny | `policy_denied` | 0 | `0 / 0 / 0 / 0` |
| 越权 Request Override | `override_unauthorized` | 1 | `0 / 0 / 0 / 0` |
| Protocol 不兼容 | `protocol_incompatible` | 1 | `0 / 0 / 0 / 0` |
| Tool Use Capability 不支持 | `capability_unsupported` | 1 | `0 / 0 / 0 / 0` |

### 5.3 P2-E08 分支证据

| Provider detail | Mode | 当前 Turn retry budget | 下一相同 key Turn | 下一不同 key Turn | Compaction / terminal |
|---|---|---|---|---|---|
| exact `64000` | Turn-local | `128000 -> 64000` | `128000` static | `128000` static | 1 request / success |
| exact `64000` | retained | `128000 -> 64000` | `64000` observed | `128000` static | 1 request / success |
| conservative `96000` | Turn-local | `128000 -> 96000` | `128000` static | `128000` static | 1 request / success |
| conservative `96000` | retained | `128000 -> 96000` | `96000` observed | `128000` static | 1 request / success |
| no detail | Turn-local | `128000 -> 128000` | 未产生 observation | 未产生 observation | 1 request / success on retry |
| no detail，第二次仍 overflow | Turn-local | 两次均 `128000` | 未产生 observation | 未产生 observation | 1 request / second error returned |

## 6. 计数与脱敏观察

| 观察面 | 结果 |
|---|---|
| SDK/network/paid probe | current Anthropic Adapter 的 fake SDK `messages.stream` 只在成功执行场景调用；P2-E07 各失败路径均为 0；全套 network sentinel 为 0 |
| Parent/Child overlap | `maxActiveLeases = 2`；显式 Parent、显式 Child 和 inherited Child 共 3 次 acquisition / 3 次 release；shared resource close count 为 1，第二次 close 被拒绝 |
| Abort/Usage | overlap 中 Parent 为 `aborted`、Usage `0/0`；Child 为正常完成、Usage `7/3`；Event session identity 无串扰 |
| Overflow | exact `64000` 与 conservative bound `96000` 都只收紧原 `128000`；Turn-local 不影响下一 Turn；retained 只影响相同 `Provider + Endpoint + Model` key |
| Retry/Compaction | first overflow 后最多一次 retry；second overflow 直接返回；每次 recovery 最多一个 instrumented Session-owned Compaction request |
| Dependency direction | allowed `Compatibility -> New Core` edge 存在；forbidden reverse transitive path count 为 0 |

所有观察均为 synthetic identity、endpoint、usage 和 fake response；没有保存 credential、真实用户输入或真实 Provider response。

## 7. 发现

### 7.1 支持的目标判断

1. 一个 Runner 上游的 Resolver 可以在不复制 Runner loop 的情况下选择两个 Provider implementation，并将完整执行事实固定到 per-Turn Resolved Model；
2. Provider 可以在自身边界内确定性合并 `effectiveContextLimit` 来源，保留 provenance/conflict diagnostics，并让 fallback 只补缺、observation 只收紧；其他 Facts 的 precedence 尚未由本 Spike 验证；
3. unknown model 的有效 limit 可以来自明确 `provider-default`，但 request encoding 所需的缺失 Capability 必须 fail closed；
4. Parent/Child 可以共享唯一 owner 管理的 read-only Provider resource，同时保持 Resolved Model、stream、Usage、Event、Abort 和 lease 独立；
5. Compatibility 可以保持单向输入，新 Resolver/Core 不需要反向依赖 Legacy；
6. target-shaped overflow coordinator 可以保持 Runner 的 decision/retry ownership、Provider 的 error normalization/observation ownership 和 Session 的 persistence mechanism ownership。

### 7.2 当前实现差距

Spike 没有修复、也不应掩盖以下 current Runner gap：

- `AgentRunner` 仍包含 `200000` legacy context default；
- `AgentRunner` 仍解析 raw Provider error string；
- current `ContextOverflowError` 没有 Provider limit correction；
- current retry budget 没有 correction input。

这些是 Slice 1 Module Spec 的设计输入，不是本 Spike 的 production change authorization。

### 7.3 未命中的 Stop Conditions

`AF05-ST01..AF05-ST07` 均未命中：实验不需要复制 Runner/Tool loop、修改 production、由 Core 猜 Facts、共享 per-Turn mutable state、访问网络/secret/paid probe、反转 Compatibility dependency、改变 Resolved Model 或跨 observation key 污染；开始与结束均为 2026-09-03，实际执行小于 1 个工作日，未达到 2 个工作日硬停止。

## 8. 假设评估

| 假设 | 证据 | 评估 |
|---|---|---|
| `P2-H01` Provider 内来源合并 | `P2-E03` 直接证据；`P2-E02`、`P2-E06`、`P2-E08` 无反例 | Supported |
| `P2-H02` Provider fallback 与最小安全 Facts | `P2-E04` 直接证据；`P2-E02`、`P2-E07` 无反例 | Supported |
| `P2-H03` Parent/Child 资源共享边界 | `P2-E05` 直接证据；`P2-E01`、`P2-E06` 无反例 | Supported |
| `AF05-H01` 汇总假设 | `P2-E01..P2-E08` 全部 Pass；无 Stop Condition | Supported / Provisional Pass |

该评估只适用于本 Results 记录的 Windows、版本、fake transport、independent Fake Provider、controlled overlap 和 disposable target-shaped coordinator。

## 9. 限制与剩余风险

- current Anthropic Adapter 使用 hoisted fake SDK transport；没有验证真实 SDK transport、HTTP、Provider metadata、credential、rate limit、billing 或供应商错误 payload；
- independent Fake Provider 不构成 OpenAI-compatible production support 或协议兼容承诺；
- P2-E05 使用 controlled overlap，不授权 production Subagent concurrency，也不验证 RuntimeApp tracked Child lifecycle、Fanout 或 Shutdown tree；
- P2-E08 使用 disposable target-shaped coordinator，不证明 current `AgentRunner` 已能消费 correction，也不冻结 Error/Contract 字段；
- precedence 实验只覆盖 `effectiveContextLimit`；`maxOutputTokens`、Tool Use 和其他 Capability facts 的来源冲突与最终 precedence 仍待后续 Provider Contract/Module Spec；
- provenance、Resolution Failure 和 Resolved Model 的 TypeScript shape 都是 disposable evidence，不是 production API proposal；
- resource pool 只验证一个 read-only owner、lease/release 和 single close，不验证真实 socket pool、backpressure 或 process Shutdown；
- 证据只在 Windows/Node `v22.22.2`/ABI `127` 上执行；未做跨平台 Spike；
- root regression 保护 current behavior，但不能替代后续 Module Spec、Contract tests 和真实 caller migration。

## 10. 决策影响

项目所有者已接受本 `Provisional Pass`，它可以作为以下后续工作的输入：

- 接受、修订或拒绝 Target `P2-H01..P2-H03`；
- AF-07 中 Provider/Model identity、Model Facts/Metadata ownership 和渐进迁移 ADR；
- Slice 1 Module Spec 中 Resolver、Resolved Model、Provider Binding、Compatibility direction 和 overflow correction responsibility；
- Foundation Gate 的 AF-05 evidence item（仅该项，已同步为完成）。

它不改变生产代码，不表示 Foundation Gate 整体通过，不授权跳过 AF-06，也不决定最终 Provider Contract、Catalog、Policy、Client Pool 或 Error union。

## 11. 工作树与可复现性

执行时 package metadata 与 lockfiles 无变更：`package.json`、`package-lock.json`、`pnpm-lock.yaml` 均 clean。

除本 Spike fixture、Spec、Results、父计划和文档索引外，working tree 还包含 AF-04 已接受但未提交的文档、Characterization、Fitness 和 deterministic image fixture 变更。AF-05 没有把这些既存差异当作自身实验实现。

接受前，所有 Spike 命令均从 repository root 复现；fixture-local Vitest config 使用唯一 `.spike.ts` include，root `npm test` 不会重复运行该矩阵。接受后的 mandatory cleanup 已删除 fixture，因此 isolated Spike 命令不再可执行；本 Results 保留环境、命令、矩阵和复审记录作为 durable evidence，repository lint/test/build 仍可复现。

## 12. 独立复审

首轮实现复审发现 4 High、4 Medium、2 Low evidence gaps；这些 findings 指向 assertion/instrumentation 不足，没有命中 architecture Stop Condition。修正包括真实 next-Turn observation resolution、bounded retry exhaustion、overlap Abort、inherited resolution、区分 local resolution/Port/SDK/network/paid-probe counters、in-flight source replacement、Capability observation、portable import scan 和 single-close enforcement。

跟进复审只剩 P2-E06 policy participation 与 P2-E07 SDK/paid-probe counter 两个 Medium；补充可区分 policy denial、actual SDK spy 和 injected paid-probe sentinel 后关闭。Results closure review 随后发现 P2-E03 尚未把 observation correction 纳入来源排列，以及 mandatory detail retention 不足；最终实验扩展为 tightening/non-tightening 各 120 个排列，并在本 Results §5.1–§5.3 保留 precedence、failure/counter 与 overflow branch matrix。最终确认无未解决 Critical、High、Medium 或 Low，`P2-E01..P2-E08` evidence 可以进入 `Provisional Pass` Results。

## 13. 后续工作

- [x] 项目所有者于 2026-09-03 接受本 Results 的 `Provisional Pass`；
- [x] 删除 `test-fixtures/architecture-spikes/af-05/**` disposable code 并执行 cleanup validation；
- [x] cleanup 记录完成后将 Spike 状态晋升为 `Completed`，同步父计划和 Foundation Gate 的 AF-05 evidence item；
- [ ] 按父计划顺序起草并接受 AF-06 Spike Spec；
- [ ] AF-05 与 AF-06 Results 都接受后再进入 AF-07；
- [ ] Slice 1 开始前创建并接受 Module Spec，不直接复制 disposable types。
