# ADR-002：上下文预算与 Compaction Recovery

## 状态

- **状态：** Accepted
- **日期：** 2026-09-01
- **所有者：** 项目所有者
- **关联计划 / Spec：** [AF-04 Characterization and Fitness Execution Plan](../roadmap/af-04-characterization-fitness-plan.md)、[Target Architecture](target-architecture.md)、[Current Compaction Design](core-runner-context-design.md)
- **替代范围：** 替代“全局 `llm.contextWindowTokens` 是所有模型的 Model Fact”“Core 应自行推断未知模型上限”以及“Compaction observer Hook 可以 detached 越过生命周期边界”的目标假设；不改写当前已实现行为。

项目所有者于 2026-09-01 接受本 ADR。后续工作遵循 [Development Workflow](../development-workflow.md) 的批准和状态规则。在所需 Spike Results、Module Spec 与独立批准的 Architecture Slice 完成前，生产行为保持不变。

## 背景

当前 Runner 分别接收所选模型和 `contextWindowTokens`。Runtime 切换模型后，可能已经改变 Model identity，却仍沿用进程级上下文上限。现有默认值是 `200,000`；它适用于部分 Anthropic 模型，但不是每个 Provider、部署、代理或自定义模型的可信事实。

上下文预算仍有价值：它可以避免可预见的无效付费请求、控制 Tool Result 增长，并在触及 Provider 硬限制前执行 Compaction。但本地估算和 Catalog 不是最终权威，因为 Provider metadata 可能过期，代理可能施加更小的部署上限，token 估算也可能与 Provider 计数不同。Provider 返回的 context overflow 是最终纠正信号。

AF-04 Batch 2 已获得通过的 CH-04 测试证据：当前 `before_compaction` 和 `after_compaction` observer Hook 不阻塞 Compaction 或 Turn settlement；该 Batch 的 Owner disposition 仍为 Pending，本 ADR 不把它升级为已接受 Characterization。针对当前代码的局部读取表明 Compaction 主流程会等待摘要和记录写入，但 CH-11 尚未执行，因此包括该等待关系、summary fallback、固定阈值、重试次数、拆分算法和持久化布局在内的现有 Compaction 细节都只属于待 CH-11 确认的 `Current Fact Candidate`。

OpenClaw、Codex、Gemini CLI 和 Cline 的对比提供了设计输入：Compaction recovery 需要保护 Tool Call/Result group、拒绝无效压缩、传播 Abort、限制恢复次数，并保持 Provider facts 与 Runner conversation semantics 的所有权分离。外部实现不是本仓库的执行证据。

## 决策驱动因素

- 每个 Parent 或 Child Turn 切换模型时，Model identity 与其有效限制必须原子切换；
- Provider 专属 discovery、部署上限、alias、Catalog 和错误格式必须留在 Provider 边界内；
- Core 不维护跨 Provider 模型表，也不根据 Provider 或 Model 名称猜测上限；
- 主动预算应减少可避免失败，但不能被视为比 Provider 更权威；
- Overflow recovery 必须产生可测进展、有界收敛，并保持 Provider-valid Tool Call/Result history；
- Provider、Runner 与 Session 的所有权必须分离；
- Compaction 必须遵守 Turn Abort、生命周期 settlement 和不可变 Turn 输入；
- 首次迁移不引入通用 checkpoint engine、自适应全局模型数据库或可恢复 workflow protocol。

## 备选方案

### 方案 A：保留一个全局上下文上限

继续独立于所选模型传入全局 `contextWindowTokens`。实现简单，但模型切换可能组合新 Provider/Model 与旧 Facts；过大默认值会把恢复推迟到 Provider 拒绝，过小默认值会造成不必要 Compaction，Core 也会意外成为 Provider 模型知识的所有者。

### 方案 B：删除主动预算，只依赖 Provider overflow

持续发送请求，直到 Provider 报告 context overflow，再压缩并重试。它避免使用过期本地上限，但每次 overflow 都增加延迟和潜在费用，完全依赖 Provider 错误分类，失去 Tool loop 的提前保护，并可能不给 Compaction 请求留下足够空间。

### 方案 C：Provider 提供有效上限，主动预算与有界 overflow recovery 并存

Provider Integration 返回带 provenance 的有效上下文上限，Runner 用于主动预算；Provider overflow 仍是最终纠正信号。Compaction 决策留在 Runner，权威持久化机制留在 Session。

Provider 可以在内部使用受信 metadata、部署配置、静态目录、保守观测或 Provider-owned fallback。这能在保留预测价值的同时把 Provider 细节隔离在 Core 之外。

### 方案 D：只对可信上限主动预算，未知模型采用被动恢复

Provider 可以显式返回“上限未知”。Runner 对已知上限启用主动预算，对未知模型跳过窗口预算并等待 Provider overflow。该方案避免虚构 fallback，但会让 Core/Runner 增加 `unknown` 分支，并失去未知模型的主动保护。它作为 AF-05 的保留备选：如果 P2-E04 证伪“Provider 能为可执行模型给出安全有效上限或 Provider fallback”，必须先修订本 ADR，再选择该方案或拒绝该模型。

### 方案 E：中央自适应模型上限服务

构建跨 Provider Catalog，统一 discovery、学习和协调 context limit。它会复制 Provider 知识，并引入 Endpoint 间的冲突与失效问题；当前仅有一个 bundled Provider 的迁移不值得承担该复杂度。

## 决策

选择 **方案 C** 作为目标方向，但将 Provider fallback 的可行性、内部来源合并和跨 Turn 观测持久化保留为 AF-05 Hypothesis。若 P2-E03、P2-E04 或 P2-E08 失败，必须先修订本 ADR，不能在生产 Slice 中临时加入 Core 猜测或未批准的 `unknown` 分支。

### Provider-owned model limits

Provider Integration 是模型参数的权威 producer 和解释者。Model Catalog / Model Resolution 保留 `Model Descriptor` 的逻辑所有权、provenance 校验和不可变 per-Turn `Resolved Model` 绑定责任。

成功生成 `Resolved Model` 的目标输入包含 Provider 返回的正整数有效上下文上限及 provenance。Provider 内部可以考虑部署或 Endpoint 配置、受信 Provider metadata、Provider 维护的静态目录、保守观测修正和为已接受模型提供的 Provider-owned fallback；这些内部来源能否覆盖全部目标场景仍由 AF-05 验证。

以下内容仍是 AF-05 Hypothesis，不是本 ADR 宣称已经验证的结论：

- 每个 Provider 都能为其接受的未知模型安全产生有效上限或 fallback；
- bundled Anthropic Provider 可以把 `200,000` 作为带 `provider-default` provenance 的兼容 fallback；
- Provider 内部来源优先级可以确定、可追踪且保持保守；
- overflow 观测适合跨 Turn 持久化。

无论 AF-05 最终采用何种 Provider 内部策略，fallback 只能补缺，不能覆盖适用的非 fallback Fact；overflow correction 只能收紧，不能放宽。`200,000` 不得成为 Stable Core 或跨 Provider 默认值。

模型切换必须原子替换 Provider binding、protocol、Endpoint/Deployment identity、capabilities、有效上限和 provenance。Turn 不得组合新 Model identity 与旧模型 Facts。

### 预算权威

主动 context budgeting 是预测和优化，不是 Provider 是否接受请求的最终事实。当有效上限与估算请求大小表明 headroom 不足时，Runner 可以裁剪允许裁剪的 Tool Results，或在 Model invocation 前执行 Compaction。即使主动预算预测可容纳，请求仍必须保留 Provider overflow correction 路径。

与模型上下文无关的绝对 Tool Result 大小、request body 等资源保护属于 Application Policy，不依赖有效模型上限。

### Overflow 归一化和 correction

Provider Adapter 将可识别的 Provider-specific overflow 响应映射为 core-owned `ContextOverflowError`，并可以附带：

- Provider 明确报告的有效上限；
- 失败请求能够证明的保守上界；
- 仅确认 overflow、但不提供 correction。

Runner 不解析 Provider 原始错误，也不反推模型上限。Correction 只能缩小当前 Turn 的 retry budget，不修改 Turn-pinned `Resolved Model`。

Provider 是否为后续 Turn 保留观测由 AF-05 验证。若保留，必须按 Provider、Endpoint/Deployment 和 Model identity 隔离；新 Turn 重新解析后才可能取得更新值。观测不是 Core shared state。

### Compaction 所有权、Session commit 与生命周期

Runner 负责：

- 决定 prune、compact、retry 或 fail；
- 选择进入 Compaction 的 conversation content；
- 构造和验证 Compaction candidate；
- 通过 Session-owned Contract 请求 accepted Compaction transition；
- 执行 Abort、deadline、有界 retry 和 no-progress 规则。

Session 拥有权威 history、Compaction record 和相关 metadata 的 mutation/persistence。Session 接收 Runner 已验收的 candidate，并以源历史 identity/precondition 为条件原子提交 accepted Compaction transition；Runner 不直接修改权威 history 或 metadata。具体事务机制由 Module Spec 冻结。Provider 不执行 conversation Compaction，也不写 Session。

Compaction 在 Turn 生命周期中是 blocking 的。在 required Compaction work、Session transition 和 observer 逻辑 settlement 完成前，Runner 不得开始 retry Model invocation 或完成 Turn。

`before_compaction` 和 `after_compaction` 保持 observer-only。Observer 可以并发执行，但 Hook Runtime 必须在对应边界内把每个 observer 归类为 fulfilled、rejected、aborted 或 timed-out，Runner 等待这些 failure-isolated 逻辑结果。Observer failure 不变换 candidate 或 result。

每个 observer 接收生命周期 AbortSignal。Deadline 胜出时，Hook Runtime 记录 timed-out settlement，Runner 可继续对应边界；晚到完成不得再影响 candidate、Session、Event 或 Turn outcome，并由 Hook Runtime 仅作诊断记录。Observer 在 timeout 后继续产生外部副作用属于 Hook Contract 违反；本 ADR 不通过无限保留 Turn pin 来等待不响应取消的第三方代码。具体隔离和 deadline 数值由 Module Spec 冻结。

该 Hook 决定不定义 `after_tool_call`；Tool Result transformation 和 ordering 由独立 Tool Hook Contract 决定。

### Candidate 验收

Runner 只有在全部适用检查通过后，才向 Session 请求提交 Compaction candidate：

- summary 或 replacement context 结构有效且非空；
- 使用同一 estimator 时，projected context 严格小于 source context；
- 自动 recovery candidate 加上下一次请求的 system、Tool definitions 和当前输入后，能够落入 correction 收紧后的 retry budget；没有 correction 时，至少必须严格缩小，且同一 no-progress 策略不得再次执行；
- 保留历史不拆分一个原子 Tool exchange group；
- Abort 或 deadline 未在 commit 前胜出。

原子 Tool exchange group 指同一次 normalized assistant emission 中的一个或多个完整 Tool Calls，以及下一次 Model invocation 前为这些 call identity 收集的 terminal Tool Results。切分必须整体保留或整体进入摘要，不能只保护单个 pair 而拆开同批 sibling calls/results。

Session commit 成功后 candidate 才成为已安装的 Compaction；失败或 precondition 不匹配时不得产生成功记录。仅包含消息数量的通用 fallback 不足以构成可安装语义历史，除非后续 Module Spec 定义并验证能保留 continuation facts 的确定性 replacement。

被拒绝的 candidate 不得安装为成功 Compaction record。Recovery 不得无限重复等价 no-progress 策略。caller-facing failure taxonomy 和 fallback 顺序由 Module Spec 冻结。

### 刻意不冻结的细节

本 ADR 不固定：

- 通用百分比阈值或 reserve-token 值；
- 通用 Provider fallback 值；
- Tool Result 字符数限制；
- 保留 recent Turns 的数量；
- deadline 时长或 retry 次数；
- summary Prompt、summary schema 或专用 Compaction model；
- checkpoint、staged summary 或 post-index synchronization；
- 具体 TypeScript 类型、Event 字段、error payload 或 persistence layout。

这些细节分别由 Provider policy、AF-05 Spike Results 和后续 Module Spec 所有。

## 后果

### 正面后果

- 模型切换携带匹配的 Provider Facts，不再依赖脱离 Model identity 的全局上限；
- Core 与 Provider 模型目录和错误格式保持隔离；
- 主动预算与 Provider-observed correction 互补；
- 无效或语义空洞的 Compaction 不会静默安装为成功；
- Tool exchange integrity、Abort 和有界 retry 成为显式目标不变量；
- Runner、Session 与 Provider 所有权可独立验证和替换。

### 负面后果

- 每个 Provider Integration 都必须实现 model-fact resolution 和 overflow normalization；
- 保守 fallback 可能过早压缩，乐观 fallback 可能先产生一次失败请求；fallback 本身仍需 AF-05 证明；
- Correction 准确性依赖 Provider 错误的细节与一致性；
- Candidate 验收会增加估算工作，并可能把当前弱 fallback 转为显式 recovery failure；
- bounded observer settlement 会增加 Hook Runtime 契约和诊断责任，无法阻止违反 Contract 的第三方代码在 timeout 后自行产生外部副作用。

## 验证

- AF-04 CH-04 的 Batch 2 测试已提供当前 detached Compaction observer 证据，但 Owner disposition 仍为 Pending；目标测试必须证明 lifecycle-bound bounded settlement，且 observer failure 不成为 transformer；
- AF-04 CH-11 必须在生产替换前 characterization 当前 trigger、fallback、persistence、Tool pairing、Abort 和 post-Compaction state；
- AF-05 P2-E02 验证原子模型切换；P2-E03/P2-E04 验证 Provider source precedence、fallback 可行性和 provenance；P2-E08 验证 overflow correction、Turn pinning、观测隔离和 Runner/Session ownership；
- Contract tests 必须覆盖 known limit、Provider fallback、明确 correction、保守上界、无详情 overflow、同 key/跨 key 观测、Abort、Hook timeout/late completion、无效 candidate、有界 retry 和原子 Tool exchange boundary；
- Module Spec 必须在实现前冻结 summary failure、retry taxonomy、observer deadline、Session commit precondition 和 persistence failure outcome。

外部 Agent 对比只作为设计输入，不是仓库权威：OpenClaw 提供 reserve headroom、Provider-overflow recovery、Tool pairing、timeout/Abort 和 optional checkpoint；Codex 把模型 metadata 绑定到 context-window transition；Gemini CLI 拒绝空摘要和 token 反增；Cline 验证 recovery 缩减目标并限制 overflow retry。

## 迁移与回滚

1. 保留 AF-04 对当前 budgeting、detached Hooks、fallback、persistence 和 retry 的 Characterization tests；
2. 完成 AF-04 CH-11 disposition；
3. 完成 AF-05 Provider/Model 实验并发布 Spike Results；若 P2-E03/P2-E04/P2-E08 失败，先修订本 ADR；
4. 接受 context budgeting 与 Compaction recovery Module Spec；
5. 通过 Compatibility 将旧 `llm.contextWindowTokens` 交给 bundled Provider 解释为 deployment override，不再直接作为 Runner/global Model Fact；
6. 通过 `Resolved Model` 传递 Turn-pinned effective limit 和 provenance；
7. 实现 Provider overflow normalization/correction，同时保持 Compaction 在 Runner；
8. 实现 candidate acceptance、Session atomic transition、Abort/deadline、bounded observer settlement 和 no-progress recovery；
9. Target contract tests 通过后再替换过时的 current-behavior assertions，并在生产迁移后更新 Current Architecture。

回滚必须保持 Provider/Model/limit 的完整绑定。版本回滚可以恢复 legacy implementation，但不能保留新模型切换却只回退 limit resolution。没有替代恢复路径时，不得移除 Tool exchange-safe history 和有界 Provider-overflow handling。

## 后续事项

- [x] 项目所有者于 2026-09-01 接受本 ADR；
- [ ] 确认 AF-04 Batch 2 Owner disposition；
- [ ] 完成 AF-04 CH-11 Characterization 和 disposition；
- [ ] 完成 AF-05 P2-E02/P2-E03/P2-E04/P2-E08 并发布 Spike Results；
- [ ] 编写并接受所需 Module Spec；
- [ ] 生产变更前链接独立批准的 Architecture Slice；
- [ ] 生产迁移后更新 Current Compaction Design。
