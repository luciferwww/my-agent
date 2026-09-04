# Model Resolution Module Spec

## 状态

- **状态：** Accepted
- **版本：** 0.1
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **Plan Item：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Slice 1
- **关联 ADR：** [ADR-002](adr-002-context-budgeting-and-compaction-recovery.md)、[ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-004](adr-004-provider-model-identity-and-facts-ownership.md)、[ADR-005](adr-005-extension-registry-runtime-composition.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)
- **证据输入：** [Target Architecture §5](target-architecture.md#5-provider-and-model-resolution)、[AF-05 Results](af-05-provider-model-resolution-spike-results.md)、[Legacy Migration Inventory](legacy-migration-inventory.md)

本 Spec 遵循 [Development Workflow](../development-workflow.md) 和 [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)。项目所有者于 2026-09-04 接受本 Spec，并确认 MR-OD-01 的 Provider-owned deployment facts policy 与 MR-OD-02 的单向 Child Compatibility adapter；该接受不授权 production 修改或 Slice 1 Delivery。

## 1. 目的与用户可观察结果

Slice 1 建立一个 Parent Turn Model Resolution 权威路径。direct library Parent Turn 与 queued WebSocket Parent Turn 在进入 Runner 前必须：

- 生成一个内部一致、不可变、per-Turn 的 Resolved Model；或
- 返回可分类的 Resolution Failure，且不发生 Model Invocation、Provider SDK 网络请求或付费探测。

成功切换 Model Reference 时，Provider/Model identity、Invocation Port binding、Protocol、Endpoint/Deployment identity、Capability Facts 和执行限制必须原子一致。现有 stream、Usage、Tool Use、Abort、Session、queue、Fanout 和 message correlation 行为保持不变，除非本 Spec 明确列入验收变化。

## 2. 范围

Slice 1 包含：

- Model Reference、Model Descriptor/Catalog view、Model Policy、Request Override、Resolved Model 和 Resolution Failure 的逻辑 Contract；
- Provider Integration Binding、startup-configured readonly Provider projection 和 core-owned Model Invocation Port；
- 一个 bundled Anthropic-compatible Provider Module；
- legacy static LLM Config 的单向 Compatibility mapping；
- direct `RuntimeApp.runTurn()` 和 queued WebSocket `run_turn` Parent Turn；
- Runner 对同一 Resolved Model 的 Tool loop、context budgeting 和 Compaction retry 消费；
- Provider overflow/error normalization 与 ADR-002 的责任衔接；
- 对现有 public/runtime inputs 的明确 Compatibility/deletion boundary。

## 3. 非目标

Slice 1 不包含：

- Child/Subagent 独立 resolution、`inherit` 目标语义或 `llmDefaults` 最终删除；这些属于 Slice 2；
- Provider runtime enable/disable、reload、candidate transaction、retirement 或动态 Snapshot replacement；这些属于 Slice 5；
- OpenAI、Gemini、Bedrock 等第二个 production Provider；Fake 只用于 Contract Tests；
- remote model discovery、paid probing、Core-owned 跨 Provider model database 或 arbitrary Provider fallback；
- Client Pool、credential persistence、Catalog remote refresh 或 marketplace；
- Session persistence redesign、Tool/Hook/Channel migration、Subagent concurrency 或 Runtime Composition 全面收敛；
- 冻结目录布局、最终 TypeScript public shape、Error/Event payload shape 或锁/队列 primitive；
- 批量移动/删除 Legacy 文档或执行完整 Legacy closeout。

## 4. Current baseline 与真实 caller

### 4.1 当前路径

queued production path：

`WebSocketChannel.parseMessage()` → `handleRunTurn()` → `RuntimeApp.handleInboundChannelMessage()` → queue scheduler → `startQueuedTurn()` → `runTurn()` → `runTurnInternal()` → `requireModel()` / static fact assembly → `AgentRunner.run()` → startup-held `LLMClient` → `AnthropicClient.chatStream()`。

direct library path 从 public `RuntimeApp.runTurn()` 进入，并在 `runTurnInternal()` 汇合。

对应实现入口：

- [WebSocket Channel](../../src/adapters/channel/WebSocketChannel.ts)；
- [RuntimeApp](../../src/runtime/RuntimeApp.ts)；
- [Runtime bootstrap](../../src/runtime/bootstrap.ts)；
- [Runner](../../src/core/runner/AgentRunner.ts)；
- [AnthropicClient](../../src/adapters/llm/AnthropicClient.ts)。

### 4.2 第一个真实迁移控制点

第一个真实 Parent Turn caller 是 `RuntimeApp.runTurnInternal()`。Model Resolution 在该控制点进入 Runner 前完成，因此 direct 与 queued caller 共用同一路径；不得在 CLI、WebSocket 或 script 中分别增加 Provider/Model 分支。

识别 caller 和冻结迁移方式属于 Definition of Ready；实际迁移、验证和旧路径删除属于 Slice 1 Delivery/Definition of Done。

### 4.3 迁移前保护线

当前行为由以下 evidence 保护：

- AF-04 CH-13 的 explicit/config model precedence 与 default facts baseline；
- Runtime direct/queued intake、queue ordering 和 correlation tests；
- Runner Tool loop、Usage、Abort、Compaction 和 Provider failure tests；
- Config loader precedence tests；
- Anthropic Adapter stream/event/Tool/image/error tests；
- Subagent model/Usage/Abort/Event baseline，直到 Slice 2。

Characterization 保护迁移前事实，不把 static Model Facts ownership 升级为长期 Contract。

## 5. Ownership 与依赖方向

| 概念 | 权威所有者 | 允许输入/消费者 | 禁止责任 |
|---|---|---|---|
| Configuration | Platform Configuration | 加载并做格式/Schema 校验；向 Compatibility 提供 legacy input | Connection/Model Facts 语义、Provider 选择、Resolved Model |
| Provider Connection | Provider Integration | Configuration input；Composition 提供 binding | Model Policy、默认模型、跨 Provider fallback |
| Provider/Model identity | Model Resolution | Model Reference、Provider projection、Catalog view | SDK Client、credential、Provider-private merge |
| Model Facts interpretation | Provider Integration | Provider metadata/static catalog/deployment override/provider fallback/observation | Application Policy、Core 品牌猜测 |
| Model Descriptor/Catalog view | Model Resolution；facts 由 Provider Contract 产生 | Resolver | Provider 私有 merge algorithm、credential store |
| Model Policy | Application Policy | Agent policy、runtime constraints | Facts、Connection、Provider metadata |
| Request Override | 当前 Turn input；Resolver 校验 | allowlisted fields | 全局 state、未授权 Provider switch |
| Provider Integration Binding | Provider Extension Contract；Composition 提供 | Resolver、Invocation Port | SDK type 泄漏、Runtime private state、Service Locator |
| Resolved Model | Model Resolution 生成；Turn Execution 消费 | RuntimeApp、Runner、budgeting | mutable Catalog/Policy、明文 credential、跨 Turn 自动更新 |
| Model Invocation Port | Stable Core | Runner 调用；Provider Adapter implements | Provider SDK 类型、Config loader、Runtime private state |
| Resolution timing | RuntimeApp | Turn start context、Resolver result | Provider-specific Facts interpretation、Provider branch |
| Tool/Compaction loop | Runner | Resolved Model、core-owned Port | Config loading、Provider selection、Model Facts inference |

源码依赖方向必须为 Provider Adapter → core-owned Model Invocation Port。Runner、RuntimeApp、Domain 不得导入 Provider SDK type。Compatibility 只能调用新权威边界，新 Core/Resolver/Provider Module 不得依赖 Compatibility。

## 6. 逻辑 Contract

本节冻结语义而非最终 TypeScript shape。

### 6.1 Model Reference

Model Reference 是 caller/Profile 提供的解析输入，至少能表达目标 Model identity，并在需要时表达显式 Provider identity。它不包含完整 Facts、SDK Client、Endpoint 或解析结果。

legacy precedence 在 Slice 1 保持：当前 Turn 显式 `model` 优先于 resolved static config 的 default `model`。该规则属于 Compatibility policy，不成为 Provider Facts precedence。

无效、空白、无法规范化或产生多义 Provider/Model identity 的 Reference 必须失败，不得按品牌字符串猜测。

### 6.2 Provider projection 与 Binding

Composition 在 startup 建立 readonly Provider projection。一个 accepted Provider entry 至少提供：

- stable Provider identity；
- Connection validation/resolution capability；
- Model Descriptor/Facts resolution capability；
- 与同一 Provider identity 绑定的 core-owned Model Invocation Port implementation；
- required Capability 与 protocol compatibility validation；
- Provider error normalization。

Builtin 与 External 的 acquisition 差异不得进入 Resolver Contract。Slice 1 不提供 runtime mutation；Config/installation 变化通过 restart 生效。

### 6.3 Model Resolver

Resolver 接收当前 Turn context、effective/default Model Reference、允许的 Request Override、Model Policy 与 readonly Provider projection，返回：

- 成功：immutable Resolved Model；或
- 失败：Resolution Failure。

Resolver 不执行 Model Invocation、Tool loop、Config load、SDK client construction 或 Session mutation。

### 6.4 Resolved Model 不变量

成功结果在逻辑上原子绑定：

- canonical Provider/Model identity；
- 同一 Provider entry 的 Model Invocation Port binding；
- Protocol；
- 不暴露 credential 的 Endpoint/Deployment identity；
- Provider-produced、带 provenance 的 execution-critical Facts；
- Model Policy result；
- 已验证 Request Override；
- 最终执行限制及来源。

Catalog、Policy、Config 或 Provider projection 后续变化不改变进行中的 Turn。Runner 的 Tool loop、Compaction retry 和同一 Turn 后续 Model Invocation 继续使用同一 binding。

### 6.5 Model Invocation Port

Port 继续承载 normalized request、stream event、Usage、Abort、Tool Use/media content 和 core-owned error。Provider Adapter 在内部完成 SDK/protocol mapping。Runner 不查看 Provider raw response、raw error string 或 SDK Client。

## 7. 解析流程

Parent Turn 在进入 Runner 前按顺序执行：

1. 选择并规范化 effective Model Reference；
2. 查找 Provider identity 与 Provider Integration Binding；
3. 由 Provider Integration 校验 Connection；
4. 取得 Provider 已解析、带 provenance 的 Model Descriptor/Facts；
5. 应用 Model Policy；
6. 校验 allowlisted Request Override；
7. 校验 Protocol、Endpoint/Deployment、Capability 与请求限制的一致性；
8. 原子生成 Resolved Model，或返回 Resolution Failure。

任何 failure 都必须发生在 Invocation Port/SDK stream/network/paid probe 之前。Resolver 不静默换 Provider、不使用测试 Fake、不让 Core 猜值。

## 8. Execution-critical Facts 与 provenance

| Fact | Slice 1 要求 |
|---|---|
| Provider/Model canonical identity | Resolver 根据 normalized Reference 和 selected binding 形成；必须与 Port/Facts 同源 |
| Invocation Port binding | 来自 selected Provider entry，不得复用上一 Model/Provider client |
| Protocol | Provider Integration 明确声明；Core 不推断 |
| Endpoint/Deployment identity | 从已验证 Connection/binding 解析；Resolved Model 不含明文 credential |
| `effectiveContextLimit` | 正整数；precedence 固定为 applicable deployment override > Provider metadata > static Provider catalog > provider-owned fallback；observation 只可收紧，不可放宽；每个结果保留 provenance |
| maximum output capability | Provider-produced 且有 provenance；legacy `maxTokens` 是 policy default/Request Override，不自动成为 capability fact |
| Tool Use capability | 当前请求包含 Tools 时必须由 Provider 明确支持；缺失或 false 均 fail closed |
| media capability | 当前请求含对应 media 时必须由 Provider 明确支持；缺失或不兼容 fail closed |
| applied output request limit | 不得超过 Provider capability 或 Policy；区分 static policy default 与 per-Turn override 来源 |

除 `effectiveContextLimit` 外，不采用一个通用 precedence shortcut。Provider Module 必须逐项定义来源规则；fallback 只能补缺，不能覆盖适用的非-fallback fact。

### 8.1 Context overflow correction

Provider Adapter 将可识别的 context overflow 归一化为 ADR-002 的 core-owned error/correction。correction 只可作为当前 Turn 后续 retry 的保守收紧，不修改 immutable Resolved Model，不放宽原限制。新 Turn 重新 resolution 后才可观察 Provider 内部更新的 conservative observation。

Runner 继续拥有 prune/compact/retry/fail 决策；Session 继续拥有 Compaction commit。Slice 1 不重开 ADR-002 的 candidate、Tool exchange、deadline、no-progress 或 observer settlement 决策。

## 9. Resolution Failure taxonomy

Slice 1 至少区分以下语义类别；最终 public Error/Event payload shape 在 implementation 前由本 Spec Review 确认，但不得用 message matching 替代类别：

| Category | 条件 |
|---|---|
| `provider_unregistered` | Reference 指向没有 accepted Provider entry 的 Provider |
| `connection_missing` | 所需 Connection input/credential reference 缺失 |
| `connection_invalid` | Connection 对选定 Provider/Endpoint 无效 |
| `reference_invalid` | Model Reference 无效或无法规范化 |
| `model_rejected` | Provider 不接受该 Model identity |
| `model_ambiguous` | identity 可解析为多个不等价候选 |
| `facts_insufficient` | 缺少请求编码或执行安全所需 Fact/provenance |
| `policy_denied` | Model Policy 拒绝候选 |
| `override_unauthorized` | Request Override 字段或值不被允许 |
| `protocol_incompatible` | binding、Endpoint 或 Model 与 Protocol 不一致 |
| `capability_unsupported` | 当前请求所需 Tool/media/其他 capability 明确不支持 |

每个类别必须满足 Invocation Port、SDK network 和 paid-probe count 为零。RuntimeApp 按 §9.1 将 failure 映射为 caller-facing failure 和 correlated terminal outcome。

### 9.1 Caller-facing failure 语义

本 Slice 冻结语义，不冻结最终 TypeScript payload shape：

- direct `RuntimeApp.runTurn()`：保持 current failure lifecycle，先有 Runtime `turn_start`；resolution 失败时记录一个 scope=`run` 的 Runtime `error` 并 reject `RuntimeAppError`，不发成功专用的 Runtime `turn_end`；
- effective Model Reference 缺失、空白或无效的 `reference_invalid` 保持 public `MODEL_MISSING` compatibility code；其他 resolution categories 映射为 public `RUN_FAILED`，但 typed cause/diagnostic 必须保留原 resolution category，不得靠 message matching 恢复；
- queued WebSocket caller 已在 enqueue 时完成 transport request，因此 resolution 失败时必须向该 session/turn 的 audience fanout 一个现有 Agent `error` terminal event；event 必须保留稳定 resolution category、`sessionKey`、`turnId` 和 `originMessageId` correlation；
- queued failure 不发 Runner `run_start` 或 `run_end`，因为 Runner 未被调用；也不发 `channel_error`，后者只表示 wire/protocol/handler intake failure；
- direct 与 queued 路径对同一 Resolution Failure 使用相同 category 和 public compatibility code；每个路径只产生一个 caller-visible terminal failure。

WebSocket serialization 必须保留 category 和 message，不能把 typed error 降成无法分类的字符串。该行为由 Runtime direct/queued integration 与 WebSocket protocol tests 验证。

## 10. Lifecycle、资源与安全

- Composition 创建 bundled Provider Module 与 readonly Provider projection；
- Provider Module 拥有 SDK Client、connection/cache/auth/rate-limit 等内部对象及其关闭责任；Framework 只管理 Provider Module instance，不管理其内部 resource graph；
- Resolved Model 只持有受控 binding/reference，不泄漏明文 credential 或 SDK object；
- 一个 Turn pin 其 Resolved Model，不能在执行中观察 Config/Catalog/projection mutation；
- Slice 1 没有 dynamic reload/retirement transaction，也不新增 watcher；
- Abort 继续透传到 Invocation Port；本 Slice 不改变 process Shutdown contract；
- logs/events 不得输出 credential、authorization header 或 Provider-private Connection secret。

## 11. Compatibility 与 migration

### 11.1 legacy input mapping

| Current input | 单向 mapping | Target owner |
|---|---|---|
| `llm.apiKey`、`llm.baseURL` | legacy Provider Connection input | Provider Integration |
| static/config `llm.model` | default Model Reference | Model Resolution input |
| per-Turn/WebSocket `model` | explicit Model Reference | 当前 Turn input / Model Resolution |
| static `contextWindowTokens` | provider-interpreted legacy deployment override，带 `legacy-config` provenance；不得作为 Core default | Provider Integration |
| static `maxTokens` | Model Policy default output request limit | Application Policy |
| per-Turn/WebSocket `maxTokens` | allowlisted Request Override，受 capability/Policy 上界约束 | 当前 Turn input / Model Resolution |
| startup `LLMClient` | selected Provider Binding 的 core-owned Invocation Port | Provider Module / Composition |

Compatibility 不拥有 Facts、Policy、Catalog、Registry、lifecycle 或 Turn state，也不从 recommended main barrel 导出。

### 11.2 Parent caller migration

1. Composition 提供 bundled Anthropic-compatible Provider Module 和 startup readonly projection；
2. `RuntimeApp.runTurnInternal()` 在进入 Runner 前调用 Resolver；
3. direct 与 queued Parent Turn 都传一个 Resolved Model；
4. Runner 全部 Model Invocation、Tool loop 和 Compaction retry 使用该 binding；
5. 验证成功后删除 direct client/static fact path。

### 11.3 Slice 2 临时边界

Subagent 仍是 production caller，且当前与 Parent 共用 `AgentRunner`。Slice 1 不允许新 Runner Core 反向依赖 legacy Child params，也不能假装 Slice 2 已完成。

推荐的最小 Compatibility policy 是：在 Runner 新 Contract 外建立具名的 one-way Child adapter，把当前 `llmDefaults`/Child inputs 只映射为带 `legacy-child` provenance 的 Model Reference、Provider Connection input、Policy default 和允许的 Request Override，再调用与 Parent 相同的 Resolver/Provider Contracts 取得 Resolved Model，最后调用只消费 Resolved Model 的新 Runner Contract。该 adapter 不得自行生成 Model Facts、选择未声明 fallback 或构造 authoritative binding。该 adapter：

- Slice 1 Owner 负责创建、单向依赖约束和初始 Compatibility validation；Slice 1 close 时 ownership 移交 Slice 2 Owner，后者负责到期与删除；
- caller 仅限当前 `SubagentRunner`/host path；
- 到期为 Slice 2；
- 不改变 `inherit`、Usage、Abort、Event 或 Session current behavior；
- 不进入 recommended barrel；
- Slice 2 建立 target independent Child resolution 后删除。

项目所有者于 2026-09-04 接受该 policy；后续若要改变，必须先修订本 Spec，不能让 Runner 保持双权威接口。

### 11.4 rollback

默认 rollback 使用完整版本/发布回滚。Slice 1 不预设 Feature Flag。若 Delivery evidence 证明必须使用 startup migration Flag，必须先在 Inventory 登记 Owner、默认值、观测信号、trigger、完整旧/新 path 和删除 Slice；一个 Turn 内不得混合新 identity 与旧 client/facts。

### 11.5 删除条件

Slice 1 完成前必须满足：

- `bootstrap` 不再直接 import/construct `AnthropicClient`；
- `RuntimeResourceSet.llmClient` 不再是 authoritative client slot；
- `RuntimeApp.requireModel()` 已删除；
- Parent execution 不再读取 `resolvedConfig.llm` 拼装 model/context/max-output facts；
- Runner 不再拥有 Model Fact default，不再解析 Provider raw error；
- Runner execution Contract 只消费 Resolved Model/core-owned Port；
- Infrastructure-owned LLM types/barrel 已迁移或收窄，不再被 Stable Core 反向依赖；
- public/runtime inputs 已删除，或在 [Legacy Migration Inventory](legacy-migration-inventory.md) 中作为有 Owner、callers、到期 Slice、validation 和 deletion conditions 的 Compatibility 保留；
- Slice 2 Child adapter 是唯一允许的临时旧入口，新 Core 不依赖它；
- 没有 hidden Flag、reverse dependency 或 mixed-path rollback；
- Slice 1 结束时满足 `Legacy_end < Legacy_start`。

## 12. Bundled Anthropic-compatible Provider policy

仓库默认脚本允许 custom `baseURL` 和非 Anthropic model ID。Provider Module 不能仅凭 `anthropic` 品牌或 model string 声称 capability。

### 12.1 Provider-owned deployment facts input

为避免把 current custom Endpoint/unknown Model 支持建立在 Core 猜测上，bundled Provider Module 提供自己的 validated Config Namespace。该 logical contract 不冻结最终字段名或 TypeScript shape，但必须表达：

- facts entry 的精确作用域：Provider identity + normalized Endpoint/Deployment identity + canonical Model identity；不得只按 model string 跨 Endpoint 复用；
- `effectiveContextLimit`：正整数与来源；legacy `contextWindowTokens` 只能映射到当前 legacy deployment/model entry，并标记 `legacy-config`；
- maximum output capability：正整数上限与来源；legacy `maxTokens` 仅是 request default/override，不自动成为 capability fact；
- Tool Use capability：显式 boolean 与来源；
- media capability：显式 supported media kinds 与来源；
- Protocol：Provider Module 声明并与 Adapter/Endpoint 校验；
- entry trust/source：`deployment-config`、Provider metadata、static Provider catalog 或 `provider-default`，Configuration 只做结构/类型校验，Provider Integration 负责适用性和语义解释。

同一事实的冲突按 §8 规则处理；字段缺失不能由 Config loader、Resolver 或 Core 猜测。明文 credential 不进入 facts entry。Schema invalid、scope 不匹配或互相冲突的 entry 在 startup/resolution 阶段失败，不进入 Invocation。

### 12.2 Compatibility consequence

推荐 policy：

- bundled Module 表示 Anthropic protocol-compatible integration，不把 custom proxy 冒充 Anthropic catalog；
- known catalog entry 可以使用 Provider-owned static facts；
- custom Endpoint/unknown Model 必须通过 §12.1 的显式 deployment facts 提供当前请求所需 execution-critical capability；
- 只有 `effectiveContextLimit` 可以使用带 `provider-default` provenance 的保守 Provider fallback；
- Tool/media/maximum-output 等影响当前请求编码或安全的 fact 缺失时 fail closed；
- 不执行 remote discovery 或 paid probe。

current `LLMConfig` 没有 Tool/media/maximum-output deployment-facts surface。因此，custom Endpoint/unknown Model 在迁移后若没有 matching static Provider catalog 或新增 deployment facts，使用对应能力的请求将 fail closed；这是需由项目所有者明确接受的 compatibility change，不声称无条件保留所有现有 proxy 请求。普通 legacy fields 只按 §11.1 映射，不能伪造缺失 capability。

项目所有者于 2026-09-04 接受该 input contract、fail-closed consequence 和 policy；后续若选择更宽或更窄的兼容边界，必须先修订本 Spec并继续符合 ADR-004。

## 13. 验收场景

- **AC-MR-01 Compatibility equivalence：** 等价 legacy static input 与 native input 产生语义等价、provenance 可区分的 Resolved Model。
- **AC-MR-02 One Parent path：** direct `RuntimeApp.runTurn()` 与 queued WebSocket `run_turn` 使用同一 Resolver control point。
- **AC-MR-03 Atomic switch：** per-Turn model selection 原子切换 identity、Port、Protocol、Endpoint 和 Facts，不复用上一 selection 的 binding。
- **AC-MR-04 Turn pin：** Turn 执行期间 Config/Catalog/projection 改变不影响其 binding；下一 Turn 重新 resolution。
- **AC-MR-05 Fail closed：** §9 每个 failure category 都在 Invocation/network/paid probe 前失败。
- **AC-MR-06 Capability：** 有 Tools/media 的请求在 capability 缺失或 unsupported 时调用前失败。
- **AC-MR-07 Behavior preservation：** stream、Usage、Tool Use、Abort、Session write、queue ordering、Fanout 和 correlation 保持 current accepted behavior。
- **AC-MR-08 Overflow authority：** Provider Adapter 归一化 overflow；correction 只收紧当前 Turn retry budget，不修改 Resolved Model。
- **AC-MR-09 Direction：** New Core 无 Compatibility dependency，Compatibility 不从 recommended barrel 导出。
- **AC-MR-10 Slice 2 boundary：** Subagent current behavior 保持；临时 adapter 可见、单向、具名、到期，只映射 inputs 并调用同一 Resolver，不生成 Facts/Resolved Model。
- **AC-MR-11 Deletion：** §11.5 的被替代 Parent paths 删除或具名降级，Inventory 更新且 Legacy 净减少。

## 14. 分层验证

### 14.1 Unit

- Resolver stage/failure matrix；
- identity normalization 与 ambiguity；
- Model Policy/Request Override allowlist；
- per-fact provenance 与 consistency；
- `effectiveContextLimit` precedence、fallback-only-on-missing、observation-only-tightening；
- Tool/media/output capability fail-closed；
- immutable per-Turn binding。

### 14.2 Provider Contract

bundled Anthropic-compatible Adapter 对 controlled SDK transport 验证：request、stream events、Usage、Abort、Tool Use、image/media 和 normalized errors。Fake Provider 运行同一 core-owned Port/Resolver Contract suite，但不作为 production fallback。

### 14.3 Runner Contract

- Runner 不接受 raw static Facts 或 Infrastructure-owned SDK Client；
- 同一 Turn 的重复 Tool/Compaction calls 保持一个 Resolved Model；
- Runner 不按 Provider/model string 猜测事实；
- overflow correction 与 ADR-002 retry/Compaction semantics 保持。

### 14.4 Integration

- `RuntimeApp.runTurnInternal()` direct caller；
- WebSocket queued caller；
- startup Provider projection；
- static Compatibility equivalence；
- Resolution Failure 的 caller/event terminal mapping；
- temporary Child adapter 的 current-behavior preservation。

### 14.5 Regression 与 Static

- CH-13 replacement、Runtime intake/queue、Runner Provider failure/Usage、Config loader、Abort、Session 和 Subagent baseline；
- FT-01、FT-02、FT-03、FT-04、FT-06、FT-08；
- FT-04 必须扩展到最终批准的 production/Compatibility paths，不能只依赖未来目录名；
- document diagnostics、FT-09、local link audit、`npm run lint`、相关 Vitest、`npm run build` 和 `git diff --check`。

不增加与现有保护重复的泛化测试；每项新增测试必须直接证明一个新 Contract、failure category、真实 caller migration 或依赖方向。

## 15. Definition of Ready 检查

- [x] 关联 Plan Item 明确；
- [x] 用户可观察结果和非目标明确；
- [x] 关联 ADR 已 `Accepted`；
- [x] AF-05 已消除 architecture-level Provider/Model resolution unknown；
- [x] 模块 ownership 和依赖方向明确；
- [x] Compatibility、rollback 和旧路径删除条件已起草；
- [x] 聚焦、Contract、Integration、Regression、Fitness、lint 和 build 范围已起草；
- [x] MR-OD-01：项目所有者接受 bundled Anthropic-compatible Provider 对 custom Endpoint/unknown Model 的 §12 policy（2026-09-04）；
- [x] MR-OD-02：项目所有者接受 Slice 2 临时单向 Child Compatibility policy（2026-09-04）；
- [x] API-M01–M04 已在 Inventory 记录 bounded repository callers、Compatibility 保留期和 deletion blocker；未知 external consumer 阻止删除，不阻止本 Spec 接受；
- [x] 本 Spec 完成 independent review，Critical/High/Medium findings 已解决（2026-09-04）；
- [x] 项目所有者接受本 Spec 并将状态改为 `Accepted`（2026-09-04）；
- [x] 不存在会使结论失真的 unresolved blocker。

DoR 达成只使 Slice 1 可以进入 Foundation Gate 复评；不自动授权 Delivery。

## 16. 已确认决策

### MR-OD-01：custom Endpoint / unknown Model Facts

**决定：** 项目所有者于 2026-09-04 接受 §12 的 Provider-owned explicit deployment facts + limited context fallback policy。它为 custom proxy 提供明确迁移入口，同时不让 Core 猜 Tool/media/output capability；没有 matching catalog/facts 的现有请求可能 fail closed，该 compatibility consequence 一并接受。

替代方案：

1. 只允许 known catalog models：边界最严格，但会主动打破当前 custom proxy/model 用法；
2. 为所有 unknown facts 使用 generic fallback：兼容更宽，但违反 capability fail-closed，不可接受；
3. live discovery/paid probe：当前证据不支持，会引入新 Spike 和更大范围。

### MR-OD-02：Slice 1 到 Slice 2 的 shared Runner transition

**决定：** 项目所有者于 2026-09-04 接受 §11.3 的具名 one-way Child adapter，Slice 2 到期。这样 Runner 新 Contract 保持唯一，Child 行为暂时不变，也不把完整 Child resolution 偷带入 Slice 1。

替代方案：

1. Runner 长期接受 legacy/new 双输入：形成双权威，不可接受；
2. Slice 1 同时完成 Child resolution：扩大 Slice 1 并破坏既定顺序，不推荐；
3. 复制第二套 Runner：增加长期分叉，不可接受。

上述两项 Contract/Compatibility owner decision 已完成，不需要新 Spike。只有后续改为依赖未验证 live SDK metadata、真实 endpoint discovery 或 paid probing 时，才需要先接受新的 Spike Spec。

## 17. 后续状态

本 Spec 与 Legacy Inventory 已完成独立 review、blocking finding 修正和项目所有者接受；Foundation Gate 已通过。下一步仍须项目所有者单独批准 Slice 1 进入 Delivery，当前不授权 production 修改。
