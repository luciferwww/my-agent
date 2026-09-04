# ADR-004：Provider/Model Identity 与 Model Facts Ownership

## 状态

- **状态：** Accepted
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **关联计划 / Spec：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-07、[AF-07 Architecture Decision Spec](af-07-architecture-decision-spec.md)
- **证据输入：** [Target Architecture §5](target-architecture.md#5-provider-and-model-resolution)、[AF-05 Provider/Model Resolution Spike Results](af-05-provider-model-resolution-spike-results.md)
- **相关既有决策：** [ADR-002 Context Budgeting and Compaction Recovery](adr-002-context-budgeting-and-compaction-recovery.md)
- **适用原则：** AP-01、AP-02、AP-03、AP-06、AP-07、AP-09、AP-12，见 [Architecture Principles](architecture-principles.md)
- **Supersedes：** None

项目所有者于 2026-09-04 接受本 ADR。后续工作遵循 [Development Workflow](../development-workflow.md) 的批准和状态规则；本次接受不冻结 production TypeScript API，也不授权 Model Resolution Slice。

## 背景

当前 static LLM config、Runtime 组装和 Runner 参数混合了 Provider connection、Model identity、上下文限制、最大输出和 client binding。Model string 改变并不能证明 Endpoint、Protocol、Capability 和限制事实同步改变；Core 也不应维护跨 Provider 的品牌知识或猜测未知模型能力。

AF-05 disposable Spike 已证明：在 production graph 外，一个 Resolver 可以从 legacy/native input 形成内部一致的 per-Turn Resolved Model；Provider 可以在自身边界内合并带 provenance 的 `effectiveContextLimit` 来源；Parent/Child 可以独立解析并隔离 mutable per-turn state；不可解析或不允许的输入可以在 Model invocation 前 fail closed。

这些证据支持逻辑 ownership 和 dependency direction，但不冻结最终 Provider Contribution schema、TypeScript shape、完整 Facts precedence、Catalog、Client Pool 或 Error union。

## 决策驱动因素

- Model identity 与执行 Port、Protocol、Endpoint 和 Facts 必须原子一致；
- Provider-specific SDK、metadata、错误和 fallback 留在 Provider Integration；
- Facts、Connection、Policy、Config input 与 Request Override 必须分责；
- Runner 只执行，不重新解析或猜测 Model Facts；
- Parent/Child 每个 Turn 独立解析并固定输入；
- 缺少 execution-critical Facts 时在网络调用前 fail closed；
- 与 ADR-002 的 budgeting/Compaction authority 不重叠。

## 备选方案

### 方案 A：继续由全局 LLM Config 和 Runner 拼装执行参数

Config 同时提供 Provider、model、client、context limit 和 max output；Runtime/Runner 在调用时补默认值。

实现最接近当前结构，但事实会在 Config、Runtime、Runner 和 Adapter 间复制。切换 model 可能保留旧 client/endpoint/facts，Core 也必须了解具体 Provider。

### 方案 B：建立 Core-owned 跨 Provider 中央 Model 数据库

由 Stable Core 维护所有 Provider/Model Catalog、别名、Capabilities 和限制，再选择具体 Adapter。

它能形成统一查询入口，但会复制 Provider metadata 和部署语义，且要求 Core 解释供应商更新、代理 Endpoint 与 fallback。当前 evidence 不支持该复杂度。

### 方案 C：Provider 解释事实，Model Resolution 形成 per-Turn immutable binding

Provider Integration 解释 Connection 和 Provider-produced Facts；Model Resolution 应用 Reference、Catalog、Policy 和允许的 Override，生成内部一致的 Resolved Model；Runner 只消费结果和 core-owned invocation Port。

该方案保持 Provider-specific knowledge 在边界内，同时让 Application 拥有选择和 Turn binding。

## 决策

选择 **方案 C：Provider 解释事实，Model Resolution 形成 per-Turn immutable binding**。

### Ownership

| 概念 | 权威所有者 | 不得承担 |
|---|---|---|
| Provider identity | Model Resolution | Endpoint、credential、SDK client、用户选择策略 |
| Model identity | Model Resolution | Provider Connection、Facts、Policy 或执行 binding；Model Reference 只是解析输入，Model Descriptor/Facts 是验证来源 |
| Provider Connection semantics | Provider Integration | Model Capability、默认模型、fallback Policy |
| Protocol / Provider Adapter behavior | Provider Integration | Core 业务规则、Session mutation |
| Model Reference | Model Resolution；由 caller/Profile 提供 | 完整 Facts、Connection、client |
| Model Descriptor / Catalog view | Model Catalog / Model Resolution；事实由 Provider Contract 提供 | Provider 私有 merge algorithm、用户偏好 |
| Model Facts interpretation | Provider Integration | Application Policy、跨 Provider 猜测 |
| Model Policy | Application Policy | Facts、Connection、Provider metadata |
| Request Override | 当前 Turn input；由 Model Resolution 校验 | 全局状态、未授权 Provider switch |
| Provider Integration Binding | Provider Extension Contract；由 Composition 提供 | SDK type 泄漏、Runtime private state |
| Resolved Model | Model Resolution 生成；Turn Execution 消费 | mutable Catalog/Policy、明文 credential、跨 Turn 自动更新 |

Configuration 只加载并做格式/Schema 校验，不成为 Connection 或 Model Facts 的语义 owner。Composition 提供 binding，不解释 Provider facts。Compatibility 只映射旧 input，不拥有新的 resolution policy。

### Resolution 与 fail-closed

每个 Parent/Child Turn 在进入 Runner 前独立执行：

1. 规范化 Model Reference；
2. 选择 Provider identity/binding；
3. 让 Provider Integration 校验 Connection 并解析带来源 Facts；
4. 应用 Model Policy；
5. 校验允许的 Request Override；
6. 检查 Protocol、Endpoint、Capability 和限制一致性；
7. 原子生成 Resolved Model，或返回可分类 Resolution Failure。

Provider 未注册、Connection 无效、Model 不存在/歧义、Policy deny、Override 越权或 Protocol 不兼容时，必须在 Provider network invocation 前失败。execution-critical Facts 至少包括：正整数 `effectiveContextLimit` 或由该 Provider 明确提供并标注来源的 fallback、已解析的 Protocol、Endpoint/Deployment identity、当前请求所需 Capability，以及其他会影响请求编码或执行安全的必要限制；任一缺失或不一致都必须 fail closed。具体字段 shape、provenance 表达和除 `effectiveContextLimit` 外的 precedence 仍由后续 Module Spec 冻结。不得静默换 Provider、使用 Fake 或由 Core 猜值。

### Per-Turn binding

成功的 Resolved Model 在逻辑上原子绑定：

- Provider/Model canonical identity；
- 对应的 core-owned Model Invocation Port binding；
- Protocol 与 Endpoint/Deployment identity；
- Provider 返回且带来源的 Capability facts 和执行限制；
- Policy result 与已验证 Request Override。

Catalog、Policy、Config 或 Registry 后续变化不改变进行中的 Turn。Runner 的 Tool loop、Compaction retry 和同一 Turn 后续调用继续使用该 binding；新 Child Turn 重新解析，但可以通过 `inherit` 使用 Parent effective Model Reference，而不是共享 Parent Resolved Model 或 mutable request state。

### Facts 与 provenance 边界

Provider Integration 可以在内部组合部署覆盖、Provider metadata、static catalog、provider-owned fallback 和按 Provider/Endpoint/Model 隔离的保守 observation。每个最终 Fact 必须保留来源，fallback 只能补缺，observation 只能收紧。

AF-05 直接验证了 `effectiveContextLimit` 的来源优先级、`provider-default` fallback 和 overflow observation 行为。该证据**不**冻结 `maxOutputTokens`、Tool Use、media 或所有 Capability Facts 的最终 precedence；后续 Provider/Model Module Spec 必须为这些字段逐项定义来源和 fail-closed 规则。

### 与 ADR-002 的 Authority 边界

本 ADR 不 supersede、修改或复制 ADR-002。以下事项继续以 ADR-002 为权威：

- context budgeting 与有效上限的执行使用；
- Provider overflow normalization/correction；
- Runner 的 prune/compact/retry/fail decision；
- Session-owned Compaction commit；
- Tool exchange-safe candidate、no-progress、deadline 和 observer settlement。

如本 ADR 的 ownership wording 与 ADR-002 发生冲突，必须在本 ADR 进入 `Accepted` 前显式解决；不能因为编号更新而静默覆盖 ADR-002。

## 原则与验证映射

| 原则 | 本决策约束 | 后续验证 |
|---|---|---|
| AP-01 | Runner/Core 不依赖具体 SDK/Provider branch | FT-01/02/03、second Provider change-locality test |
| AP-02 | Connection、Facts、Policy、Override 分责 | Resolver unit matrix、schema/type review |
| AP-03 | 每个 Turn 一个 immutable Resolved Model | Runner contract、config-change、Parent/Child integration |
| AP-06 | 每项事实一个 owner | ownership/type/export audit |
| AP-07 | legacy config 单向映射 | compatibility dependency fitness、caller inventory |
| AP-09 | Resolution failures 和 Port contract 显式 | Module Spec、Provider contract tests |
| AP-12 | Provider abstraction 由 Anthropic + Fake evidence 支持 | AF-05 mapping、real caller migration review |

## 后果

### 正面

- Model switch 不再混合新 identity 与旧 client/endpoint/facts；
- Provider-specific metadata、SDK 和错误留在 Adapter/Integration；
- Runner 不承担 Config、Catalog 或 Provider selection；
- Parent/Child 可以选择不同 Provider/Model 且互不污染；
- 不安全或不可解析输入在付费调用前失败。

### 负面

- 每个 Provider Integration 必须提供 Facts resolution 和 provenance；
- Model Resolver 需要显式 failure taxonomy 和 consistency validation；
- legacy LLM config 需要 Compatibility migration；
- 完整 Facts precedence 要在 Module Spec 中逐项决定，不能依赖一个通用 merge shortcut。

## Deferred

本 ADR不冻结 production TypeScript shape、Provider Contribution schema、Catalog storage/refresh、Client Pool、credential injection、Error union、policy language、exact fallback value、全部 Capability Facts precedence、persistence 或 observability payload。真实 Provider compatibility 需要独立 Contract/Integration evidence。

## 迁移与回滚

1. Slice 1 Module Spec 冻结 Model Reference、Resolved Model、Provider Binding、failure taxonomy 和 caller migration；
2. bundled Anthropic 作为真实 Provider Module，Fake 只用于 Contract tests；
3. 旧 static config 经单向 Adapter 映射 Connection、Reference 和允许的 Override；
4. Parent Runtime caller 迁移到 Resolver + Resolved Model + invocation Port；
5. 删除 Runtime 直接构造 Anthropic client、`requireModel()` 和 Runner global fact assembly；
6. Slice 2 独立迁移 Child/Subagent resolution；
7. 发布窗口 rollback 可切回完整旧版本；不得保留新 Model identity + 旧 fact path 的混合回退。

## 后续事项

- [x] 项目所有者接受本 ADR（Owner：项目所有者；Plan Item：AF-07；2026-09-04）。
- [x] 起草并接受 [Slice 1 Model Resolution Module Spec](model-resolution-module-spec.md)（Owner：项目所有者；Plan Item：Slice 1；2026-09-04）。
- [x] 在 Slice 1 Spec 中逐项冻结 execution-critical Facts 和 failure taxonomy（Owner：项目所有者；Plan Item：Slice 1；2026-09-04）。
- [ ] 在 Slice 2 Spec 中冻结 Parent/Child resolution 与 `inherit` 语义（Owner：项目所有者；Plan Item：Slice 2）。
