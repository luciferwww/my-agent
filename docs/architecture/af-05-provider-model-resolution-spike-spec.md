# AF-05 Provider/Model Resolution Spike Spec

## 1. 状态

- **状态：** Accepted
- **版本：** 0.1
- **日期：** 2026-09-03
- **所有者：** 项目所有者
- **建议时间盒：** 1 个工作日；2 个工作日硬停止
- **父计划：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-05
- **语言与术语约定：** [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)
- **权威目标：** [Target Architecture §5](target-architecture.md#5-provider-and-model-resolution)
- **行为与 Fitness 基线：** [AF-04 Characterization and Fitness Execution Plan](../roadmap/af-04-characterization-fitness-plan.md)
- **相关约束：** [Architecture Principles](architecture-principles.md)、[Domain Glossary](domain-glossary.md)、[ADR-002](adr-002-context-budgeting-and-compaction-recovery.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-03 接受本 Spec v0.1 及 §15 的实验边界、证据矩阵、时间盒和停止条件。该接受只授权 disposable AF-05 Spike，不授权 production Model Resolver、Model Registry、第二 Provider、AF-06、AF-07、Slice 1、公共 Contract 或生产目录迁移。

## 2. 单一问题

### AF05-Q01

在不修改 production graph、不复制 `AgentRunner` 核心循环、不让 New Core 反向依赖 Legacy/Compatibility 的条件下，一个位于 Runner 上游的 disposable Model Resolver，能否组合 Provider-owned Model Facts、Provider Connection、Application-owned Model Policy 和 Turn-scoped Request Override，为每个 Parent/Child Turn 独立生成内部一致且不可变的 Resolved Model，并通过两个不同 Provider Binding 对应的 Model Invocation Port 完成确定性执行和 fail-closed 失败？

## 3. 假设

### AF05-H01

可以。current Anthropic Adapter 的 fake-transport execution、一个 independent Fake Provider、单向 Legacy Compatibility Adapter、Parent/Child 不同 Model、Provider 内 Facts 合并、受控资源共享和 overflow correction 可以全部在 production graph 外验证，同时满足：

1. Runner 不读取 Config、不选择 Provider、不推断 Model Facts，也不出现 Provider identity branch；
2. 每个 Turn 只观察一个原子绑定且不可变的 Resolved Model；
3. Provider/Model 切换同步切换 Port binding、Protocol、Endpoint、Capability facts 和请求限制；
4. Parent 与 Child 独立解析，不共享 Resolved Model 或 per-turn 可变请求状态；
5. 所有不可解析或不允许的输入在 Model Invocation 前 fail closed；
6. Provider 内来源合并保留 provenance，fallback 只补缺，overflow observation 只收紧；
7. Provider 不接管 Compaction、Session persistence 或 Runner retry ownership。

本假设汇总 Target Architecture 的 `P2-H01..P2-H03`。任一 §10 Stop Condition 命中即证伪或停止，不得通过增加通用 Registry、DI Container、Service Locator、production seam 或宽松 fallback 绕过。

### 3.1 假设到证据的追踪

| 目标假设 | 直接证据 | 共享契约证据 |
|---|---|---|
| `P2-H01` Provider 内来源合并 | `P2-E03` | `P2-E02`、`P2-E06`、`P2-E08` |
| `P2-H02` Provider fallback 与最小安全 Facts | `P2-E04` | `P2-E02`、`P2-E07` |
| `P2-H03` Parent/Child 资源共享边界 | `P2-E05` | `P2-E01`、`P2-E06` |

- **Supported：** 对应直接证据通过，相关共享证据没有产生反例；
- **Falsified：** 至少一个对应实验观察到明确反例；
- **Inconclusive / Blocked：** timebox、环境或 Stop Condition 阻止形成正反证据。

单项 `P2-E*` 失败不自动证伪全部三个目标假设。`AF05-H01` 只有在八项 canonical scenario 均产生支持证据且没有命中 Stop Condition 时才可标为 Supported。

## 4. 可解锁与不解锁的决策

### 4.1 可解锁

若全部 required evidence 成立，Spike Results 可以为以下工作提供证据输入：

- AF-07 中 Provider/Model identity、Model Facts/Metadata ownership 和渐进迁移 ADR；
- Slice 1 Module Spec 的逻辑职责、Compatibility 方向和最小 Contract responsibilities；
- `P2-H01..P2-H03` 的接受、修订或拒绝；
- Foundation Gate 中“Provider/Model Spike 有 Results，关键 Hypothesis 通过”这一项的后续 Owner decision；
- Provider 内来源合并、最小安全 Facts、资源共享和 overflow correction 是否可行。

### 4.2 不解锁

本 Spike 无论结果如何都不直接：

- 授权或实现 production Model Resolver、Model Registry、Provider Module、第二 Provider 或 Slice 1；
- 修改 `RuntimeApp`、`AgentRunner`、bootstrap、Config loader、Subagent production path 或公共 exports；
- 冻结 TypeScript interface、DTO 字段、Resolution Failure union、Provider Contribution Schema、Client Pool API 或最终目录；
- 承诺 OpenAI-compatible、Anthropic 或其他真实 Provider 的生产支持；
- 验证真实 SDK、远程 Metadata、定价、网络可靠性或凭据管理；
- 处理 AF-06 的 Registry generation、动态 enable/disable、Snapshot publish、drain、retirement 或 rollback；
- 改变 AF-04 已固定的 current behavior，尤其 `MODEL_MISSING` 和由 Provider 暴露 invalid model 的当前语义。

## 5. 当前证据与实验边界

AF-04 已证明当前 Runtime 在 Runner 前只检查 model 是否缺失；非空 model 原样传递，Provider error、Usage、Event 与调用次数已有 Characterization。FT-01、FT-02、FT-03 和 FT-06 是可执行保护线，不等于 production 已全面合规：FT-01/FT-03 保留已审查的 current violation baseline，FT-06 只证明检测机制及 isolated change-locality fixture。本 Spike 不复制这些测试，而是验证尚无执行证据的动态解析、Facts provenance、per-turn pinning、Parent/Child 独立解析和 Provider resource boundary。

实验代码必须满足：

- 只位于 `test-fixtures/architecture-spikes/af-05/**`；
- 不进入 root `tsconfig` production include；
- 允许 fixture 单向 import 当前 Runner 的最小公开测试所需入口，以证明核心循环不被复制；production `src/**` 不得 import、注册或引用 fixture；
- 不修改任何 production source、production test seam、公共 Contract、dependency 或 lockfile；
- 不使用真实 Provider SDK Client、网络、凭据、production workspace/session data 或付费探测；`P2-E01` MAY 使用 OS temporary directory 中的真实 `SessionManager` fixture，且必须在每个场景后清理；
- disposable harness 的类型和目录不构成 production API proposal。

### 5.1 已知的 P2-E08 API 证据边界

Current `AgentRunner` 能识别 context overflow 并拥有 bounded Compaction retry，但仍保留 `200000` legacy context default、在 Runner 内解析 raw Provider error string，且当前 `ContextOverflowError` 不携带 Provider limit correction、当前 retry budget 也没有 correction 输入。production 修改不在本 Spike 授权内，因此：

- `P2-E01` 必须通过 unchanged current Runner 证明 Provider 差异不要求复制核心循环，并显式传入 Resolved Model 的 effective context limit，不得触发 legacy default；
- `P2-E08` 使用最小 disposable overflow coordinator 表示 Target Runner 的 bounded retry ownership，只实现“一次 invocation、一次 correction 应用、一次 instrumented Session-owned Compaction Contract、一次 bounded retry”的观察面，不复制 Tool loop、Session implementation 或 `AgentRunner`；
- Results 必须把 legacy default、raw Provider error parsing 和 correction API/input 三项 current Runner gap 记录为 Slice 1 输入；P2-E04 的 Core criterion 只约束 disposable target-shaped Resolver/New Core，P2-E08 通过也只支持目标职责分配可行，不证明 current `AgentRunner` 已符合 target 或可直接消费 correction；
- 如果该最小 coordinator 仍需要 production seam、复制 Runner 核心循环或重建 Session persistence，命中 `AF05-ST01` 并停止。

## 6. 最小实验拓扑

```text
Legacy LLM Config -> one-way Compatibility Adapter ---+
Model Reference / Policy / Request Override ----------+--> Disposable Model Resolver
Provider Bindings / Connections / Facts --------------+              |
                                                               immutable
                                                             Resolved Model
                                                                    |
                                                        Spike Turn Adapter
                                                                    |
                                                       unchanged Runner loop
                                                                    |
                                                    selected Invocation Port
```

### 6.1 固定 fixture 差异

| 实验实现 | Identity | Protocol | Endpoint identity | Effective context limit | Max output | Capability 差异 |
|---|---|---|---|---:|---:|---|
| Current Anthropic Adapter + fake SDK transport | `fake-anthropic/model-a` | `anthropic-messages` | `endpoint-a` | `200000` | `8192` | Tool Use enabled |
| Independent Fake OpenAI-compatible Provider | `fake-openai/model-b` | `openai-chat` | `endpoint-b` | `128000` | `4096` | 至少一项与 model-a 不同的编码能力 |

这些值只用于制造可观察差异。`200000` 在实验中必须带 Provider-owned provenance，不得成为 Core、Resolver 或全局 Catalog 默认值。

Current Anthropic Adapter 必须由 fixture-local SDK module mock 或等价 fake transport 驱动，并安装 network sentinel；不得新增 production injection seam。若无法在无网络、无 credential、无 production 修改的情况下驱动该 Adapter，则记录 Target/Plan feasibility conflict 并命中 `AF05-ST04`，不得静默替换为第二个 generic Fake 后仍声称 `P2-E01` 通过。该安排同时满足父计划的 Fake Anthropic 行为和 Target `P2-E01` 对 existing Anthropic Adapter 的要求。

### 6.2 Resolved Model 观察面

实验结果至少能观察以下逻辑绑定是否来自同一候选：

- normalized Provider/Model identity；
- 匹配的 Fake Model Invocation Port binding；
- Protocol 与 Endpoint identity；
- Provider 返回的 Capability facts、effective context limit 和 max output；
- Model Policy 与允许的 Request Override 结果；
- 字段级 provenance 和冲突 diagnostics。

实验对象不得包含明文 credential、SDK Client、Config loader、可变 source object 或跨 Turn 可变 request state。

### 6.3 Parent/Child 与资源共享

- Parent 使用 `model-a`，Child 使用 `model-b`；
- 使用 deferred barrier 让两次调用受控重叠，不依赖 wall-clock sleep；
- 两者可共享一个 instrumented read-only resource/pool，但必须持有独立 lease、stream、Usage、Abort 和 request state；
- `model: inherit` 只继承 Parent effective Model Reference，再为 Child 独立解析；不得复用 Parent Resolved Model；
- 每个 lease 恰好释放一次，共享资源由唯一 Lifecycle Owner 关闭一次。

## 7. 方法

1. 创建独立 `tsconfig.json`、fixture-local `vitest.config.ts` 和单一非默认发现的 Spike file；只拆出下述依赖方向证明所需的最小模块，不建设通用测试框架；
2. 先实现 current Anthropic Adapter 的 fake SDK transport、独立 deterministic Fake Provider binding、network sentinel 和 instrumented Invocation Ports；
3. 实现 disposable Compatibility Adapter、Provider-local Facts merge、Model Resolver 和 Spike Turn Adapter；
4. 在注入冲突前冻结 Provider precedence/expected-winner table；Results 记录偏差，不得回改预期使实验通过；
5. 将 disposable Resolver/New Core 与 Legacy/Compatibility Adapter 放在至少两个独立 fixture module；从 New Core entry 递归扫描 transitive imports，证明到 Legacy/Compatibility module 的 path count 为 `0`，并单独证明允许的 `Compatibility -> New Core` edge 存在；不得用同文件声明让检查 vacuous pass；
6. 按 §8 的 canonical `P2-E01..P2-E08` 顺序运行最小场景；
7. 每个场景记录 Resolved Model observation、provenance、diagnostic、Port/network counters、lease lifecycle 和 stop-condition state；
8. 运行 AF-04 相关保护线，证明实验未改写 current behavior 或 dependency boundary；
9. 将实际命令、环境、结果、反例和未决问题写入独立 Spike Results；
10. Results 获 Owner 接受后删除 disposable fixture，除非 Owner 单独批准将某个最小 Contract fixture 保留为后续 Spec 输入。

### 7.1 P2-E03 预先冻结的来源规则

Spike execution 开始时必须在 Results 中复制并冻结下表；可根据 Fake Provider 的字段最小集删除不适用行，但不得在观察结果后改变优先级或 expected winner。

| 冲突 case | 预期 winner | 必须拒绝的结果 |
|---|---|---|
| applicable deployment override vs Provider metadata/static catalog | deployment override | 未记录来源的覆盖，或由枚举顺序决定 |
| Provider metadata vs static catalog | Provider metadata | Core/Resolver 解释 Provider-private precedence |
| applicable normal source vs Provider fallback | normal source | fallback 覆盖适用的 normal source |
| prior effective limit vs stricter observation | stricter observation | 丢失 observation provenance |
| prior effective limit vs looser observation | prior effective limit | observation 放宽已知上限 |

不得把实验 harness 复制为 production candidate，也不得在 Results 前为提高通过率改变 Target hypothesis。

## 8. 必需证据矩阵

`P2-E01..P2-E08` 直接引用 Target Architecture §5.9 的 canonical IDs，不创建第二套行为编号。

| ID | 确定性实验 | 通过证据 | 失败证据 |
|---|---|---|---|
| P2-E01 | Current Anthropic Adapter 由 fake SDK transport 驱动，与独立 Fake Provider 分别通过 unchanged Runner 运行同一最小 Turn；等价 Legacy config 经单向 Compatibility Adapter 输入同一 Resolver | 两个 Provider 输出 normalized events；等价输入产生同一 Resolved Model 并显式传入 effective context limit；Runner/Runtime 无 Provider/Compat branch；fixture-local transitive import graph 证明 New Core -> Legacy/Compat path count 为 0 且允许的 Compatibility -> New Core edge 存在 | 需要复制 Runner、泄漏 SDK type、增加中央 identity union/branch、Resolver 反向读取 Legacy，或只能绕过 current Anthropic Adapter |
| P2-E02 | 在 A/B 间重复切换并记录完整执行绑定 | 每次 Port、Protocol、Endpoint、Facts 和 limits 全部来自同一候选 | 旧 Client/Endpoint/Facts 与新 model identity 混用 |
| P2-E03 | 先冻结 §7.1 precedence 与每个冲突的 expected winner，再注入并置换 deployment override、Provider metadata、static catalog、observation correction 和 fallback；包含 fallback 覆盖 trusted value 与 observation 放宽 limit 两个反例 | 每组 normal conflict 由预先声明规则选出 expected winner；枚举顺序不影响结果；fallback 只补缺；observation 只收紧；provenance/冲突可诊断 | winner 偏离预先声明规则、静默覆盖、结果依赖输入枚举顺序、fallback 覆盖适用 normal source、observation 放宽或 Core 解释 Provider-private precedence |
| P2-E04 | trusted limit、未知模型的 `provider-default: 200000`、带 Tool 请求但缺 Tool Use Fact 三种输入 | 前两者成功且 provenance 不同；第三种在 invocation 前失败；disposable target-shaped Resolver/New Core 不含 `200000` 默认 | disposable Resolver/New Core 猜测 limit/Capability、丢失 provenance 或 Facts 不完整仍调用；current Runner 的 legacy default 只记录为 Slice gap，不计作此 criterion 的结果 |
| P2-E05 | Parent A/Child B barrier overlap，共享 instrumented resource | Port/Facts/Usage/Event/Abort 不串扰；唯一 owner；lease 各释放一次；资源只关闭一次 | 必须授权 production Child concurrency；状态串扰、泄漏、重复释放或多 owner |
| P2-E06 | 活跃 Turn 捕获后替换 fixture-owned Catalog、Policy、Config source reference 或 available Binding source reference；随后启动新 Turn；不实现 Registry/Snapshot/generation/publish/drain/rollback | 活跃 Turn 保持旧 Resolved Model；新 Turn 使用新解析结果 | 活跃 Turn 重解析、漂移、观察混合版本，或实验扩张为 AF-06 lifecycle |
| P2-E07 | 未注册 Provider、Connection 缺失/无效、Reference 拒绝/无法规范化/歧义、Facts 不足、Policy deny、越权 Override、Protocol/Capability 不兼容 | 每类返回可分类失败；Invocation Port、SDK/network、付费探测 counters 均为 0 | 任一失败路径调用模型、静默切换到未选定 Provider/Fake 或产生费用 |
| P2-E08 | Provider 对 exact limit、conservative bound 和 no-detail overflow 做归一化；对 exact/bound 各运行 Turn-local correction 与 retained observation 两种模式；key 固定为 Provider + Endpoint/Deployment + Model，并以相同 key/不同 key 创建新 Turn；no-detail 经最小 disposable overflow coordinator 触发 bounded Compaction recovery | 所有分支统一返回 `ContextOverflowError`；exact/bound 只收紧当前 Turn retry budget 且不改变 Resolved Model；Turn-local 模式不改变下一 Turn；retained 模式只让下一相同 key Turn 取得收紧事实；不同 key 不受影响；no-detail 不产生猜测 correction 但仍触发 bounded recovery；coordinator 负责决策/重试并只通过 instrumented Session-owned Contract 请求记录持久化；Provider 不执行 Compaction/Session write | coordinator/Runner 解析 raw Provider error、当前 Turn 放宽或突变 Resolved Model、no-detail 猜测 correction、Turn-local 污染后续 Turn、retained observation 跨 key 污染、Provider 接管 Compaction/Session、coordinator 接管 Session persistence，或验证必须修改 production/copy Runner loop |

### 8.1 场景完成规则

- `P2-E01..P2-E08` 必须全部运行；
- 全部通过证据成立且没有 Stop Condition 命中时，Results 才可建议 `Provisional Pass`；
- 任一场景失败必须保留实际证据，并建议 `Failed`、缩小假设或修订 Target，不得以部分成功代替整体结论；
- 场景内部可有多个输入 case，但不得为每个语法变体建立重复 test file。

## 9. Resolution Failure 与未调用证明

P2-E07 的每个输入必须区分：

1. 允许本地执行的 Provider resolution Contract 调用；
2. 禁止发生的 Model Invocation Port 调用；
3. 禁止发生的 SDK/network/paid probe。

每类 counter 独立记录。`zero model calls` 不能仅从返回 Error 推断；必须由 instrumented Port 和 network sentinel 证明。Resolution Failure 的实验分类只用于比较场景，不成为 production Error union。

## 10. 失败与停止条件

以下任一条件立即停止扩大实验，并进入 Owner/Architecture Review：

- **AF05-ST01：** 必须复制 Runner/Tool loop、修改 production Runner，或增加 Provider-specific central branch 才能运行第二 Provider；
- **AF05-ST02：** Resolver/Core 必须猜测 Model Facts、Provider fallback、Protocol 或 Capability 才能形成请求；
- **AF05-ST03：** Parent/Child 必须共享 mutable request/stream/Usage/Abort state，或共享资源无法确定唯一 Lifecycle Owner；
- **AF05-ST04：** 必须访问真实网络、secret、paid probe、production storage 或修改 production graph 才能回答 AF05-Q01；
- **AF05-ST05：** Compatibility 必须被 New Core/Resolver 反向调用，或旧 `LLMConfig` 必须成为目标 Contract；
- **AF05-ST06：** overflow correction 必须改变当前 Turn 的 Resolved Model、放宽 limit、跨 key 污染，或将 Compaction/Session ownership 移给 Provider；
- **AF05-ST07：** timebox 达到 2 个工作日仍不能形成可重复证据。

停止不等于强行判定整个 Target 错误。Results 必须记录阻断点、已排除假设和下一决策，不得继续建设框架来规避失败。

## 11. 必需证据

Spike Results 至少保留：

- OS、Node.js、npm、TypeScript、Vitest 版本和 Node ABI；
- 当前 commit/hash、working-tree scope 和 lockfile 状态；
- fixture topology、两个 Provider implementation 的差异和 Provider-declared precedence；
- current Anthropic Adapter fake-transport 方法、network sentinel 结果，以及 current Runner 的 legacy default、raw Provider error parsing、correction API/input 三项 gap；
- `P2-E01..P2-E08` 每项输入、观察、counter、diagnostic、Pass/Fail 和 stop state；
- Resolved Model 的脱敏 observation 与字段级 provenance；
- Parent/Child lease、Usage、Abort、release 和 shared-resource close counts；
- exact/conservative/no-detail overflow observations；
- dependency/static checks、AF-04 protection checks 和实际命令结果；
- 与 Target/ADR-002 不一致的证据、未覆盖风险和建议 decision；
- disposable fixture 的清理状态。

不得保存 credential、环境变量值、完整用户请求、真实 Provider response 或可能产生费用的 trace。

## 12. 验证命令

Spike 主证据：

```text
npx vitest run --config test-fixtures/architecture-spikes/af-05/vitest.config.ts
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-05/tsconfig.json
```

Spike file 使用 `af-05-provider-model-resolution.spike.ts`，只由 fixture-local Vitest `include` 发现；root `npm test` 不应在 fixture 保留期间重复运行该矩阵。fixture-local static import graph assertion 作为同一 Spike suite 的独立 case 运行，输出允许的 Compatibility -> New Core edge、禁止的 New Core -> Legacy/Compatibility transitive path count 和命中的 import path。

AF-04 相关保护线：

```text
npm test -- src/runtime/RuntimeApp.test.ts src/core/runner/AgentRunner.test.ts -t "CH-13"
npm test -- src/architecture-fitness/ft-01-boundaries.test.ts src/architecture-fitness/ft-02-sdk-allowlist.test.ts src/architecture-fitness/ft-03-runner-boundary.test.ts src/architecture-fitness/ft-04-legacy-direction.test.ts src/architecture-fitness/ft-06-change-locality.test.ts
```

收口检查：

```text
npm run lint
npm test
npm run build
git diff --check
```

迭代期间只运行能推翻当前假设的最小场景；完整回归只在 Spike evidence 收口前运行一次，避免重复执行。保护线通过只证明没有破坏 AF-04，不代替 P2-E01..P2-E08 的 Spike evidence。

## 13. 约束与清理

- 使用仓库现有 Node 22.x、TypeScript、Vitest 和依赖；不得新增 package；
- 使用固定 fixture、deferred barrier、instrumented counter 和 deterministic fake；不得用 wall-clock sleep、扩大 timeout 或宽松 retry 制造通过；
- 不读取 `ANTHROPIC_API_KEY` 或其他 secret，不访问网络，不产生费用；
- 不写 production workspace/session data，不启动长期 background process；允许使用 OS temporary directory 中的真实 `SessionManager` fixture，并在场景结束后递归清理；
- 每个 test 后释放 lease、Abort listener 和 shared resource；cleanup failure 必须使场景失败；
- Results review 前保留 disposable fixture 以便复核；Results 被 Owner 接受后删除整个 `test-fixtures/architecture-spikes/af-05/**`，除非另行批准保留窄 Contract fixture；
- Spike code 不进入 public export，不作为后续 Slice 的复制起点。

## 14. 输出

AF-05 至少产生：

1. `docs/architecture/af-05-provider-model-resolution-spike-results.md`；
2. 对 `AF05-H01`、`P2-H01..P2-H03` 和 `P2-E01..P2-E08` 的 evidence-backed disposition；
3. AF-07 和 Slice 1 Module Spec 可使用、但不冻结接口的责任建议；
4. disposable experiment cleanup record；
5. 父计划 AF-05 与 Foundation Gate 的 evidence-based 状态更新方案。

Results 不得把 Fake evidence 表述为真实 Provider compatibility、production readiness 或 Foundation Gate 整体通过。

## 15. Spec 接受决策

本 Spec 晋升为 `Accepted` 前，项目所有者需确认：

- [x] AF05-Q01 与 AF05-H01 是单一、可证伪且足以回答 AF-05 的实验边界；
- [x] current Anthropic Adapter + fake SDK transport 与 independent Fake Provider 足以代表两个实现，不要求真实 SDK network；
- [x] `P2-E01..P2-E08` 全部属于同一 Timebox，且全部通过才可建议 `Provisional Pass`；
- [x] 接受 P2-E08 使用最小 disposable overflow coordinator 验证 Target ownership，并把 current Runner correction API gap 留给 Slice 1；这不声称 current Runner 已兼容 correction；
- [x] 建议 Timebox 为 1 个工作日、2 个工作日硬停止；
- [x] production、public Contract、dependency、lockfile 和 production test seam 均不可修改；
- [x] Results review 前保留 disposable fixture，Results 接受后默认删除；
- [x] 接受 Spec 只授权 disposable Spike execution，不授权 AF-06、AF-07、Slice 1 或 production migration。

## 16. 当前状态

AF-04 已完成并提供 Characterization/Fitness 保护线。AF-05 Spike Spec 已于 2026-09-03 获项目所有者接受；disposable experiment 已执行并形成 [AF-05 Spike Results](af-05-provider-model-resolution-spike-results.md)。项目所有者于同日接受其 `Provisional Pass`，全部 disposable fixture 随后删除且 cleanup validation 通过，AF-05 状态为 `Completed`。这只完成 Foundation Gate 的 AF-05 evidence item；整体 Gate 仍未通过，production 保持不变。
