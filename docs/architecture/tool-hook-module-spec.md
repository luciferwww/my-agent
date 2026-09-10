# Tool 与 Hook Module Spec

## 状态

- **状态：** Validated
- **版本：** 0.2
- **日期：** 2026-09-08
- **所有者：** 项目所有者
- **Plan Item：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Slice 3
- **关联 ADR / Spec：** [ADR-001](adr-001-tool-result-closure-and-recovery.md)、[ADR-002](adr-002-context-budgeting-and-compaction-recovery.md)、[ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-005](adr-005-extension-registry-runtime-composition.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)、[Approval Lifecycle Spec](approval-lifecycle-spec.md)
- **证据输入：** [Target Architecture §6](target-architecture.md#6-extensionmodulecontribution-and-registry)、[Target Architecture §8.4](target-architecture.md#84-tool-definitionpolicyhook-与-tool-result)、[AF-04 Plan / Results](../roadmap/af-04-characterization-fitness-plan.md)、[AF-06 Results](af-06-extension-framework-spike-results.md)、[Legacy Migration Inventory](legacy-migration-inventory.md)

本 Spec 遵循 [Development Workflow](../development-workflow.md)。项目所有者于 2026-09-08 接受以下设计输入：canonical Tool Contract 必须支持 Anthropic 与 OpenAI-compatible Tool Use 的 portable shared semantics；采用 Draft-07 语义的显式 portable Schema profile；显式 deny 同时隐藏 Provider-visible definition 并保留运行期强制；Hook 同优先级按 unit identity、contribution identity 确定排序；Tool/Compaction observer 使用 Application-owned、每 handler 固定 5 秒的 bounded settlement；Compaction Hooks 在 Slice 3 一并收敛。这里的 portable shared semantics 只指两种 wire protocol 都能表达的 definition、call 和 result correlation/content 字段，不声称 Provider wire 能往返恢复 Core-only authorization/audit outcome。

独立 Spec review 已确认无 Critical、High 或 Medium blocker，结论为 `Ready`。项目所有者随后于 2026-09-08 接受完整 Spec，并另行明确授权 Slice 3 进入 production Delivery。Delivery 验证完成后，项目所有者于同日接受验证结果并确认 Slice 3 完成，同时授权建立 Slice 3 checkpoint commit 和启动 Slice 4 Spec planning；未授权 push 或 Slice 4 production Delivery。

## 1. 目的与用户可观察结果

Slice 3 建立唯一的 canonical Tool/Hook 执行路径：

- Builtin 与 External Test Extension 通过同一受限注册 API 提供 Tool/Hook Contribution；
- 当前 Turn 只消费同一个启动期 immutable Snapshot 的 Tool/Hook typed projections；
- Provider Adapter 在自身边界完成 canonical Tool Definition、Tool Call、Tool Result 与 wire protocol 的转换；
- Anthropic 与 OpenAI-compatible reference codecs 证明 portable Tool semantics 可双向表达，不要求接入第二个生产 Provider；
- `before_tool_call` 变换后的 effective input 先通过 canonical Schema validation，再进入 Application Tool Policy、必要的 approval 和 Tool execution；
- denied、invalid、unavailable、failed、aborted、not-executed 和 unknown Tool outcomes 保持 call/result correlation；
- `after_tool_call`、`before_compaction`、`after_compaction` 不再 detached 越过下一次 Model invocation、Turn completion 或 Snapshot pin。

用户不应再因 Channel 是否已经启动、某个 Hook 是否偶然注册或 Runtime 是否完成二次 Tool 装配而得到不同的授权和 Tool 可见性。

## 2. 范围

- Tool Contribution、Hook Contribution 和对应 startup staging validation；
- 一个统一、启动期 immutable Registry Snapshot 中的 Tool/Hook typed projections；
- Builtin Tool Module 迁移，包括 filesystem、search、exec/process、web fetch、memory 和可选 Task Tool；
- 一个 External Test Extension，经与 Builtin 相同的 registration/staging path 贡献 Tool 与 Hook；
- canonical Tool identity、portable input Schema、Tool Call、Tool Result 与 execution context；
- Anthropic 与 OpenAI-compatible Tool Definition/Call/Result reference codec contract tests；
- `before_tool_call` interceptor ordering、input transformation、deny 和 fail-closed semantics；
- Application Tool Policy 的 definition visibility 与运行期 deny/allow/requiresApproval enforcement；
- approval 从 transitional `before_tool_call` Hook 中移出，改由 Runner/Application 显式编排现有 current-call capability；
- `after_tool_call` observer bounded settlement；
- `before_compaction` / `after_compaction` observer bounded settlement；
- ADR-001 controlled-Abort Tool Call/Result closure 和 unknown recovery 的最小迁移；
- 删除 CODE-E01/CODE-E02 中 Slice 3 到期的中央列表、后装配、setter 和 startup-history paths；
- 删除不再需要的完整 Prompt Tool Definition 派生，只保留 prompt 实际需要的窄 tool-name/capability projection。

## 3. 非目标

- OpenAI production Provider、OpenAI SDK、网络调用、凭据或兼容性承诺；
- 支持任意 Provider 私有 Tool feature，或把多家 wire fields 合并成 Core union；
- 完整 JSON Schema、远程 `$ref`、递归 Schema、Provider-specific Schema dialect 或自动降级重写；
- structured/multimodal Tool Result；本 Slice 的 portable model-facing result content 保持 string；
- `Allow all`、`Always allow`、session/persistent authorization 或 approval deadline；
- 修改 allow/deny pattern 语法、配置 precedence 或配置文件形状；
- Tool 并行执行、durable Tool journal、自动重放、resume workflow 或通用 scheduler；
- Channel Contribution、Channel lifecycle 或 concrete Channel migration；属于 Slice 4；
- production dynamic enable/disable、reload、generation retirement、file watcher 或 Runtime Builder 全面收敛；属于 Slice 5；
- External Extension filesystem discovery、Descriptor/module format、marketplace 或任意扫描路径；External Test Extension 只作为直接注入的契约 fixture；
- Prompt、Session、Event 或 Model Invocation 的通用重构；只修改建立本 Spec canonical Tool boundary 所必需的字段和调用方；
- per-Extension observer deadline、Hook dependency graph、Hook retry 或独立 Hook scheduler。

## 4. 当前 baseline 与问题

当前 Tool/Hook 路径存在四个权威性问题：

1. `getDefaultBuiltinTools()`、Memory Tool 拼装和 `assembleRuntimeTools()` 形成中央 Tool 列表及 mutable bundle；`RuntimeApp.create()` 又追加 Task Tool、重建 executor/LLM/prompt definitions 并调用 `AgentRunner.setToolExecutor()`；
2. Core-owned model invocation contract 仍使用 `input_schema`、`tool_use`、`tool_result` 和 `tool_use_id` 等 Anthropic-shaped vocabulary，Anthropic Adapter 因形状相同而近似透传；
3. `AgentRunner.on()` 保存可变实例注册历史，只按 priority 排序；approval 直到 `startChannels()` 才作为 Hook 安装，授权结果依赖 startup history；
4. `after_tool_call`、`before_compaction` 和 `after_compaction` 使用 fire-and-forget，可能在 Model retry、Turn completion 或未来 Snapshot release 后继续运行。

AF-04 已将这些行为确认成 current characterization，而不是 Target Contract。Slice 3 替换对应行为，不在旧路径上继续增加特例。

## 5. Ownership 与依赖方向

| 概念 | 权威所有者 | 禁止责任 |
|---|---|---|
| canonical Tool identity/input/result semantics | Stable Core / Tool Domain | Provider wire shape、Config、Channel interaction |
| Tool implementation | Builtin Runtime Module 或 External Extension | 修改 Registry、选择 Provider、访问 RuntimeApp private state |
| Hook contract 与 ordering/settlement | Stable Core / Hook Contract | approval policy、Channel transport、detached background work |
| Contribution staging 与 startup Snapshot | Runtime Composition / Registry Builder | Tool execution、per-Turn state、Extension private object ownership |
| Provider Tool encoding/decoding | 各 Provider Adapter | canonical validation、Application Tool Policy、Tool execution |
| effective-input validation | Tool execution pipeline，使用 staging 编译的 validator | Provider Adapter 猜测、Hook 自行宣称 valid |
| definition visibility 与运行期授权 | Application Tool Policy | Hook registration history、Channel 自行授权、Provider 自行过滤 |
| approval I/O | Runner/Application current-call capability | `before_tool_call` Hook、Tool implementation、Channel policy |
| Tool Call/Result closure | Runner / Turn Execution + Session-owned persistence | Provider Adapter 执行 Tool、下一 Turn 才处理 controlled Abort |
| Compaction candidate/commit | ADR-002 指定的 Runner / Session owners | Compaction observer 修改 candidate、result 或 Session |

源码依赖方向为：

```text
Runtime Module / Extension implementation
  -> core-owned Tool / Hook Contribution contracts
  -> startup Registry Builder
  -> immutable Tool / Hook projections
  -> Runner canonical Tool pipeline
  -> Provider-neutral Model Invocation Port

Provider Adapter
  -> core-owned Model Invocation / Tool contracts
  -> Provider SDK or protocol
```

Stable Core、Runner 和 RuntimeApp 不导入 OpenAI/Anthropic Tool SDK types。Provider Adapter 不执行 canonical Schema validation、Policy、approval 或 Tool implementation。

## 6. Registration、staging 与 Snapshot Contract

### 6.1 Unit 与 Contribution identity

每个已取得的 Builtin Module 或 External Test Extension 作为一个 registration unit，具有规范、稳定的 `unitId`。`unitId` 由 acquisition context 提供，Extension 不能在单项 Contribution 中伪造来源。

Tool 和 Hook Contribution 各自具有在全局对应 kind 内唯一、稳定的 `contributionId`：

- Tool 的 `contributionId` 等于 exposed Tool name；
- Hook 的 `contributionId` 是 author 声明的稳定 ID，不使用函数名或注册序号；
- identity 使用确定的 ordinal string comparison；不依赖 locale、filesystem enumeration 或 registration call order；
- 同一 unit 内重复 identity 使该 unit staging 失败；跨 unit 冲突遵循 ADR-005 已接受的 Builtin/External 冲突规则；
- Tool name 必须匹配 `^[A-Za-z0-9_-]{1,64}$`，以满足 Anthropic/OpenAI-compatible portable identity；
- 空 description、不可序列化 Schema、未知 Hook kind 或非法 priority 使 Contribution 无效。

### 6.2 受限注册 API

Author-facing API 只提供具名、类型化的注册操作。Slice 3 实现 `registerTool` 和 `registerHook`；它们是统一 Extension API 的首批 production methods，不建立独立可变 Tool Registry/Hook Registry，也不提供 `register(any)`、`get(token)` 或任意 service map。

Registration 期间：

- Tool 不执行；Hook 不触发；Transport/Provider 不启动；
- 每个 unit 写入私有 staging collector；
- External Test Extension 只能看到自己的 validated fixture config 和注册 API；
- Contribution implementation 可以闭包捕获本 unit 私有对象，但 Registry/consumer 不取得关闭权；
- Builtin Tool Module 的 workspace、Memory、Subagent delegation 等依赖由 Composition 在 module creation 时显式注入，不从注册 API 查询。

### 6.3 原子 staging

一个 unit 的全部 Tool/Hook Contributions 依次完成：

1. identity、类型和重复项检查；
2. portable Schema profile 检查与 Ajv compile；
3. Hook kind、priority 和 handler 检查；
4. cross-Contribution identity/约束检查；
5. 整组接受或整组拒绝。

无效 required Builtin unit 导致 startup 失败。无效 External Test Extension fixture 整组隔离并产生可关联诊断；其任何 Tool/Hook 都不得出现在 Snapshot。Slice 3 fixture 不建立 production filesystem loader 或长期 lifecycle resource。

### 6.4 Immutable Snapshot 与 typed projections

所有 unit staging 完成后只发布一个 startup `RegistrySnapshot`。Slice 3 至少将既有 Provider projection 和新的 Tool/Hook projections 放在同一 snapshot identity/version boundary；Channel projection 在 Slice 4 接入，dynamic generation/pin accounting 在 Slice 5 接入。

Snapshot 发布后：

- definitions、compiled validators、implementation bindings、Hook ordering 和 provenance 均不可变；
- Runtime/Runner 只取得当前 Turn 所需的 narrow Tool/Hook projection，不取得 Builder、collector 或全量 mutation API；
- Root Turn 在开始执行时捕获 startup Snapshot identity，Child 使用 Parent 的同一 identity；Slice 3 只有一个 startup generation，不实现切换；
- Tool projection 可以按 Turn-pinned Application Policy 产生 Provider-visible definitions，但不修改 canonical Snapshot；
- Hook projection 已按本 Spec 排序，Runner 不读取 registration history 或再次排序；
- 一个 Tool definition、validator 和 implementation 来自同一 Contribution，不能分别替换。

逻辑 projection 至少提供以下能力，不冻结最终文件布局：

```ts
interface ToolProjection {
  readonly definitions: readonly CanonicalToolDefinition[];
  resolve(name: string): ResolvedTool | undefined;
  visibleDefinitions(policy: ApplicationToolPolicy): readonly CanonicalToolDefinition[];
}

interface HookProjection {
  readonly beforeToolCall: readonly BeforeToolCallBinding[];
  readonly afterToolCall: readonly AfterToolCallBinding[];
  readonly beforeCompaction: readonly CompactionObserverBinding[];
  readonly afterCompaction: readonly CompactionObserverBinding[];
}
```

`visibleDefinitions()` 是 pure projection；它不执行 Tool Policy 的运行期授权决策。

## 7. Canonical Tool Contract

### 7.1 Tool Definition 与 implementation

Canonical definition 使用 Provider-neutral naming：

```ts
interface CanonicalToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: PortableToolSchema;
}

interface ToolContribution {
  readonly definition: CanonicalToolDefinition;
  execute(input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ToolExecutionOutput>;
}

interface ToolExecutionOutput {
  readonly outcome: 'success' | 'failed';
  readonly content: string;
}

interface ToolExecutionContext {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}
```

`input_schema`、`function.parameters` 或其他 wire path 不属于 canonical definition。Snapshot 对 Schema 深冻结，validator 不修改 input。

`ToolExecutionContext` v1 只包含上述 call/session/turn correlation 和 Turn lifecycle `AbortSignal`。Task Tool 所需 delegation Port 等 implementation dependency 由 Module creation 时显式闭包注入，不经 context 查询。未来 Tool 如需平台能力，必须另行增加具名 typed capability；v1 不预留任意 map。Context 不包含 RuntimeApp、Registry Builder、Provider SDK Client、全局 Config、concrete Channel 或 Service Locator。

Tool implementation 只能报告真实 `success` 或 `failed` output；它不能自行宣称 Policy deny、approval unavailable、not-executed 或 recovery outcome。signal 胜出且 implementation 以可识别 AbortError 终结时，由 Runner 选择 `aborted` canonical result。

### 7.2 Portable Tool Schema Profile v1

Profile 使用 JSON Schema Draft-07 的以下显式子集。Root 必须是 object Schema；`type` 只接受单个 string，不接受 type array。

允许关键字：

| 位置 | 允许关键字 |
|---|---|
| 所有 schema nodes | `type`、`description`、`enum`、`const` |
| object | `properties`、`required`、`additionalProperties` |
| array | `items`（single schema）、`minItems`、`maxItems`、`uniqueItems` |
| string | `minLength`、`maxLength`、`pattern` |
| number/integer | `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf` |

允许的 `type` 为 `object`、`array`、`string`、`number`、`integer`、`boolean`、`null`。`additionalProperties` 只接受 boolean 或本 profile schema。`required` 中每个名称必须唯一并存在于同节点 `properties`。所有数值边界必须有限且满足 Draft-07 关系约束。

v1 明确不接受：

- `$ref`、`$defs`、`definitions`、`$schema`、`$id`、remote reference 或 recursive schema；
- `oneOf`、`anyOf`、`allOf`、`not`、`if/then/else`；
- tuple `items`、`contains`、`patternProperties`、`propertyNames`、dependencies；
- `format`、`default`、`examples`、`title`、`nullable`；
- Provider-specific metadata、custom keyword 或 unknown keyword。

扩展 whitelist 是公共 Contract 变化，必须先证明 Anthropic/OpenAI-compatible codecs 可保真表达并更新 Spec/Contract tests；Adapter 不得私自删除、重命名或近似实现 canonical constraint。

### 7.3 Staging compile 与 effective-input validation

Delivery 使用 Ajv 作为 direct runtime dependency，并以 Draft-07、strict schema、无 coercion、无 defaults、无 property removal 的方式编译。具体配置必须保证 validator 是 observational：

- `coerceTypes = false`；
- `useDefaults = false`；
- `removeAdditional = false`；
- Schema compile error 在 staging 阶段拒绝整个 unit；
- 每次调用校验 `before_tool_call` 完成后的 effective input；
- validation failure 不进入 Policy、approval 或 Tool implementation；
- diagnostic 可以列出稳定、sanitized 的 instance paths/keywords，但 Provider wire payload、secret 或任意 object dump 不成为公共错误文本。

Ajv 只验证 canonical Schema/input。Provider dialect/capability conversion 由 Provider Adapter 负责。

### 7.4 Canonical Tool Call

Provider Adapter 必须在交给 Runner 前组装完整 Tool Call；fragment、index 和 partial JSON 不泄漏给 Runner：

```ts
type CanonicalToolCallInput =
  | { readonly state: 'ready'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly state: 'invalid'; readonly reason: 'malformed_json' | 'not_an_object' };

interface CanonicalToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: CanonicalToolCallInput;
}
```

`callId` 是 Provider 返回的 opaque correlation identity；Runner 不解析、重写或按数组位置替代它。一个 assistant response 内 call ID 必须非空且唯一。缺少 identity/name 或 duplicate call ID 是 normalized Provider response failure，任何 Tool 都不执行。

Malformed JSON 不再静默替换成 `{}`。只要 Provider 提供了可用 call ID/name，Adapter 保留 identity 并返回 `input.state = invalid`，Runner 为其生成 paired `invalid_input` Tool Result；`before_tool_call` 不接收无法解码的 input。

Adapter 可以在内部按 Anthropic content-block identity 或 OpenAI `tool_calls[].index` 并行组装多个参数分片，只在单个 call 完整后输出 canonical call。Runner 保留 Provider 给出的 call list order；Slice 3 继续顺序执行 Tools。

### 7.5 Canonical Tool Result

```ts
type ToolResultOutcome =
  | 'success'
  | 'unknown_tool'
  | 'denied'
  | 'invalid_input'
  | 'unavailable'
  | 'failed'
  | 'aborted'
  | 'not_executed'
  | 'outcome_unknown';

interface CanonicalToolResult {
  readonly callId: string;
  readonly outcome: ToolResultOutcome;
  readonly content: string;
}
```

`outcome` 是 Core audit/Hook/Event semantics；portable Provider-facing result subset 是 `callId + content`。Anthropic 可额外从非-success outcome 派生 `is_error: true`；OpenAI-compatible role=`tool` message 没有标准 error bit，因此不能假装 wire protocol 可往返恢复完整 internal outcome。Adapter 不得丢失 correlation/content，也不得把 unavailable/aborted 伪装成 user denial。

本 Slice 不建立 arbitrary metadata map。需要区分 approval、execution、persistence 等本地来源时，使用内部 typed terminal detail；该 detail 不自动发送给 Provider。

`outcome_unknown` 仅由 ADR-001 next-Turn recovery 为 durable history 中缺失 result 的 call ID 合成；正常 current-Turn pipeline 和 Tool implementation 不得返回该 outcome。Recovery 不重新触发该旧 call 的 `before_tool_call`、Policy、approval、Tool implementation 或 `after_tool_call`。

Portable 与 Core-only 字段边界固定如下：

| 语义 | Anthropic/OpenAI-compatible 都必须保真 | Core 内部保留、wire 不保证可逆 |
|---|---:|---:|
| definition name/description/portable input Schema | 是 | — |
| call ID/name/decoded object input/call list order | 是 | malformed raw fragments、Provider diagnostics |
| result call ID/string content | 是 | `ToolResultOutcome`、Policy/approval/Hook source detail |

因此“semantic-equal”只比较表中 portable 列；Core-only outcome 由当前 Turn canonical pipeline 持有，不能从 OpenAI-compatible result message 反向猜测。Anthropic `is_error` 是有损 projection hint，不扩大 shared contract。

## 8. Provider conversion contract

### 8.1 Outbound definitions

| Canonical | Anthropic | OpenAI-compatible |
|---|---|---|
| `name` | `tools[].name` | `tools[].function.name` |
| `description` | `tools[].description` | `tools[].function.description` |
| `inputSchema` | `tools[].input_schema` | `tools[].function.parameters` |

OpenAI-compatible reference codec 使用 function tool，`strict` 省略或为 `false`；v1 不把 OpenAI Structured Outputs strict subset 当作 canonical Tool Contract，因为当前 portable schemas 含 optional properties。Anthropic Adapter 不因字段形状相似而接收 Anthropic-shaped Core type。

### 8.2 Inbound calls 与 outbound results

- Anthropic：`tool_use.id/name/input` 和 stream `input_json_delta` → complete canonical Tool Call；canonical Tool Result → user content `tool_result` with `tool_use_id`，非-success 可设置 `is_error`；
- OpenAI-compatible：`tool_calls[].id/function.name/function.arguments` fragments → complete canonical Tool Call；canonical Tool Result → role=`tool` message with `tool_call_id` and string `content`；
- Provider-specific finish/stop reason、stream segmentation、SDK object、field order 和 unknown metadata 不进入 Tool Contract；
- Assistant text 与 Tool Calls 可以共存。Portable equivalence 保留聚合后的 assistant text、call list order、call identity/name/input；不承诺不同 Provider wire format 无法共同表达的 text/call block interleaving 或原始 fragment boundaries。

### 8.3 Semantic contract fixtures

不安装 OpenAI SDK。纯数据 reference codecs/fixtures 至少证明：

1. canonical definition → Anthropic/OpenAI-compatible definition，Schema constraint 无丢失；
2. 两种 definition wire fixture decode 回 canonical 后与原 definition semantic-equal；
3. Anthropic/OpenAI-compatible complete、streamed 和 multiple Tool Calls → 相同 canonical calls；
4. OpenAI interleaved argument fragments 按 call index 隔离组装；
5. malformed JSON、non-object input、missing/duplicate call ID fail closed；
6. canonical result → 两种 correlated wire result；共同字段 semantic-equal；
7. unsupported Schema keyword 在 staging/network invocation 前失败；
8. Adapter conversion 不改变 canonical Schema 或 effective input object。

这些 fixtures 只证明 Contract expressiveness/change locality，不构成 OpenAI production Provider 支持。

## 9. Hook Contract

### 9.1 Hook kinds 与共同 binding

Slice 3 只提供：

- `before_tool_call` interceptor；
- `after_tool_call` observer；
- `before_compaction` observer；
- `after_compaction` observer。

每个 Hook binding 保存 `unitId`、`contributionId`、finite integer `priority`、kind 和 typed handler。handler 获得 readonly payload 与生命周期 signal；不能取得 Registry mutation 或 Runtime private state。

### 9.2 确定排序

每个 kind 的 Snapshot projection 使用唯一排序：

1. `priority` 数值降序；
2. `unitId` ordinal 升序；
3. `contributionId` ordinal 升序。

Runner 不按调用时机重新排序。相同 identity 在 staging 已拒绝，因此不存在第四个 registration-order tie-breaker。

### 9.3 `before_tool_call`

- 对 resolved、decoded Tool Call 顺序 awaited；
- 每个 handler 看到前序 handler 产生的 effective input；
- handler 只能返回 unchanged、替换整个 input object 或 deny；不能修改 call ID、Tool name、definition 或 implementation；
- replacement 必须是 plain JSON object；非法返回或 throw 立即 fail closed，停止后续 before hooks；
- 显式 deny 产生 `denied` result；non-Abort throw 或非法返回产生 `failed` result，并以 typed detail 标明来源为 Hook；两者都停止后续 before hooks，Tool 不执行；
- Hook 的 allow/unchanged 只表示该 Hook 不反对，不授予 Policy authorization；
- 使用 Turn `AbortSignal`；signal/AbortError 胜出时当前 call 产生 `aborted`，当前 response 尚未启动的 calls 产生 `not_executed`，并进入 controlled-Abort closure；
- 不使用 observer 5 秒 deadline，也不增加独立 fixed timeout。

Unknown Tool 或 invalid decoded input 不进入 before hooks；它们分别形成 paired `unknown_tool` / `invalid_input` result，并仍进入适用的 after observers。Hook failure 不使用 `unavailable`；该 outcome 只表示本次调用所需的明确 capability 不可用。

### 9.4 Observer settlement runtime

`after_tool_call`、`before_compaction` 和 `after_compaction` 共用一个小型 bounded settlement primitive，但保持不同 typed payload/Contract：

- 同一 lifecycle point 的 handlers 并发启动；
- 每 handler 独立 settlement：`fulfilled | rejected | aborted | timed_out`；
- 每 handler deadline 从调用该 handler 时开始，固定 5 秒；
- deadline 是 Application-owned constant，不读取 Extension/global user config；
- 每 handler 获得由 Turn signal 与 deadline 共同驱动的 observer-local `AbortSignal`；
- Turn signal 胜出时，尚未逻辑完成的 handler 立即结算为 `aborted`；Runner 不再等待其底层 Promise 物理完成；
- rejected/timed-out observer 只产生带 unit/contribution/hook kind/correlation 的 sanitized diagnostic，不改变 Tool Result、Compaction 或 Turn outcome；
- timeout/abort 胜出后，late completion/rejection 不得再次 settlement，不得修改 candidate/result/Event/Session；只允许 diagnostic；
- Hook Contract 要求 handler 在 signal 后停止外部副作用。JavaScript 无法强停违规代码，本 Slice不通过无限持有 Turn/Snapshot 来等待它；
- 测试用 fake clock/deferred barrier，不以 wall-clock sleep 证明时序。

### 9.5 `after_tool_call`

每个已规范化 Tool Call terminal result 都触发一次 `after_tool_call`，包括 unknown Tool、invalid input、Hook deny/failure、Policy deny、approval denied/unavailable/failed、execution success/failure/abort、not-executed。Payload 至少包含：

- original call identity/input state；
- 最后可用的 effective input（若已成功解码）；
- canonical result/outcome；
- implementation 是否启动；
- implementation duration（只有启动后才有）；
- session/turn correlation 和 observer-local signal。

Observers 不能替换 canonical result。Runner 可以在同一 Provider response 的后续顺序 Tool 执行期间并行结算已启动的 after observers，但在以下任一动作前必须 await 所有相关 observer 的逻辑 settlement：

- 下一次 Model invocation；
- Turn terminal completion；
- 离开当前 Snapshot boundary。

### 9.6 Compaction observers

Compaction Hooks 在 Slice 3 使用与 `after_tool_call` 相同的 bounded settlement primitive，但不合并 payload 或语义：

- `before_compaction` 在一次 blocking Compaction attempt 开始实际 summary/transition work 前触发，观察 trigger、source estimate 和 correlation；它不能修改 candidate、budget、retry 或 Session；
- `before_compaction` 全部逻辑 settlement 后才能开始该 attempt；observer failure 不阻止 Compaction；若 Turn Abort 胜出，Runner按 ADR-002 lifecycle 停止后续 work；
- `after_compaction` 只在 Session-owned accepted Compaction transition 成功后触发，观察 committed stats/correlation；失败或未提交的 attempt 不伪造 after event；
- `after_compaction` 全部逻辑 settlement 后才能 retry Model invocation 或完成 Turn；
- Compaction candidate acceptance、summary failure、Session precondition、retry/no-progress 和 persistence outcome 继续由 ADR-002 及后续 Compaction implementation authority 决定，本 Spec 只收敛 Hook registration/settlement。

Observer settlement 对当前 Compaction flow 的影响固定如下：

| settlement | `before_compaction` | `after_compaction` |
|---|---|---|
| `fulfilled` | 继续 attempt | committed transition 保持，继续 retry/Turn flow |
| `rejected` | 记录诊断并继续 attempt | 记录诊断；不回滚 commit，继续 retry/Turn flow |
| `timed_out` | 记录诊断并继续 attempt | 记录诊断；不回滚 commit，继续 retry/Turn flow |
| `aborted`（Turn signal 胜出） | 不开始 summary/commit；按既有 Turn Abort 退出 | commit 已成立且不回滚；停止后续 model retry，按 Turn Abort 退出 |

Observer rejection/timeout 不消费 Compaction retry 次数，也不单独触发 retry；只有既有 Compaction decision/error taxonomy 可以决定 retry。Observer-local 5 秒 deadline 产生 `timed_out`，不伪装成 Turn `aborted`。

## 10. Canonical Tool pipeline 与 Policy/Approval

每个 complete Tool Call 按以下顺序处理：

1. 从 Turn-pinned Tool projection 解析 Tool identity，并检查 call input decoding state；
2. unknown/invalid 直接产生 paired result；否则执行 ordered `before_tool_call` chain；
3. 校验 transformed effective input；
4. Application Tool Policy 对 effective call 返回 `deny | allow | requiresApproval`；explicit deny 始终最高；
5. `requiresApproval` 由 Runner/Application 调用 current-call Approval Capability，并观察 Turn Abort/Shutdown/capability availability；
6. 只有 Policy allow 或 approval approved 才执行 Tool implementation；
7. 选择且记录一次 canonical Tool Result，发 paired canonical event/context block；
8. 启动 `after_tool_call` observers；
9. 顺序处理当前 response 的后续 Tool Calls；Turn Abort 后不启动剩余 Tools，为其生成 `not_executed` results；
10. 在下一次 Model invocation 或 Turn completion 前，持久化完整 Tool exchange 并等待所有 after observers settlement。

### 10.1 Definition visibility 与双重 deny enforcement

Snapshot 保留全部已接受 canonical Tool implementations。对当前 Turn 构造 Provider request 时，Tool projection 使用同一个 Turn-pinned Application Policy 的 explicit deny patterns 过滤 Provider-visible definitions：

- deny-matched Tool 不发送给 Provider，也不进入完整 Prompt Tool Definition；
- filtering 不删除 Snapshot implementation，不改变后续 Turn；
- allowlist 不隐藏 definitions；它决定无需人工 approval 的 runtime authorization；
- 如果 Provider 因旧上下文、缓存或 hallucination 调用已隐藏 Tool，runtime Policy 仍返回 explicit deny；不能降级为普通 unknown Tool；
- deny 始终高于 allowlist；现有 exact/glob matching semantics 保持，不在本 Slice新增 pattern language。

### 10.2 Approval 不属于 Hook authorization

Approval 不注册为 Hook，也不依赖 `startChannels()` 是否已经调用。Runner/Application boundary 显式取得当前 call route 的 narrow Approval Capability：

```ts
interface CurrentCallApprovalCapability {
  request(
    request: {
      readonly callId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly sessionKey: string;
      readonly turnId: string;
    },
    signal: AbortSignal,
  ): Promise<ApprovalResult>;
}
```

- Hook deny 可以增加限制；Hook unchanged/allow 不能授予权限；
- Channel 只承载 request/response 和 availability，不拥有 Tool Policy；
- Runtime Turn orchestration 根据当前 call route 提供或省略 capability；Runner 不接收 concrete Channel/Transport，Capability 不进入 `ToolExecutionContext`；
- capability 缺失时 `requiresApproval` fail closed；
- approved、denied、aborted、unavailable、failed 保持 [Approval Lifecycle Spec](approval-lifecycle-spec.md) 分类；
- `approved` 才进入 Tool implementation；`denied`、`unavailable`、`failed` 分别映射同名 canonical outcome；`aborted` 映射当前 call 的 `aborted` 并停止启动当前 response 的剩余 calls；
- approval 没有 fixed elapsed timeout，不能复用 observer 5 秒 deadline；
- approval terminal result 进入同一 Tool Result closure 和 `after_tool_call` path。

## 11. Abort、closure、persistence 与 recovery

Slice 3 实施 ADR-001 的最小 controlled-Abort closure：

| 当前进程可证明的 call state | canonical outcome |
|---|---|
| implementation real success | `success` |
| implementation real failure | `failed` |
| started 且明确确认取消 | `aborted` |
| 因 controlled Abort 未启动 | `not_executed` |
| crash/forced termination/legacy corruption 后无法证明 | next-Turn recovery-only `outcome_unknown` |

规则：

- actual terminal completion wins cancellation race；`signal.aborted` 本身不证明已启动 Tool 被取消；
- 已启动且不响应 signal 的 Tool 允许完成并保留真实 result；Runner 停止启动后续 Tools；
- 当前 response 中每个 complete Tool Call 在 controlled Turn settlement 前都有同 call ID result；
- batch Tool Results 在下一次 Provider invocation 前作为完整 exchange 写入 Session-owned persistence；
- persistence failure 产生 typed Turn execution failure，不把未持久化 closure 声称为成功，也不向 Provider 发送 damaged transcript；已发生 Usage 保留；
- next-Turn repair 只补 durable history 中缺失的 IDs，使用 `outcome_unknown`，不覆盖真实 result、不声称 aborted/not-executed、不自动重放；
- incomplete streamed fragment 未形成 canonical Tool Call 时丢弃/归一化为 Provider response failure，不伪造 Tool Result；
- `after_tool_call` 只观察 current-Turn pipeline 已选择的 per-call outcome；next-Turn recovery 合成旧 call 的 `outcome_unknown` 时不触发 execution Hook；observer failure 不改变 persistence 或 recovery outcome。

本 Slice不引入 durable execution receipt、idempotency protocol 或 resumable workflow。

## 12. Prompt projection

Current full prompt mode 已核验不会渲染完整 Tool definitions；Memory Recall 条件只依赖精确 Tool name。Slice 3 因此删除独立 `PromptToolDefinition` 全量派生：

- Provider definitions 只从 canonical Tool projection 产生；
- Prompt builder 只接收实际需要的 readonly Tool names/capability facts；
- Memory 条件保留现有精确名称语义，不读取 description/schema；
- Prompt 不建立第二份 Tool schema authority。

若未来 Prompt 需要完整 Tool rendering，必须从 canonical definitions 只读投影，不能新增第二种 author-facing definition。

## 13. Compatibility、migration 与删除

### 13.1 Migration sequence

1. 增加 core-owned canonical Tool/Hook Contribution、portable Schema checker 和 immutable projections；
2. 增加 Anthropic/OpenAI-compatible pure codec contract fixtures；先证明 Contract expressiveness；
3. 将 Builtin Tools、Memory Tools 和 Task Tool 迁入同一 Builtin Module registration path；
4. 将 Anthropic Adapter 改为显式 canonical conversion；
5. 将 Runner 改为一次注入 Turn-pinned Tool/Hook projections 和 explicit Policy/Approval dependencies；
6. 收敛 Tool pipeline、Ajv validation、observer settlement 和 ADR-001 controlled closure；
7. 加入 External Test Extension fixture，证明同 registration/staging path 和 narrow capabilities；
8. 迁移真实 Runtime caller，删除 central mutable bundle、Task 后装配、executor setter 和 approval startup Hook；
9. 删除重复 prompt definition projection，同步 inventory/current docs/plan。

首个 production caller 切换后，同一进程不保留 old/new Tool pipeline Feature Flag。rollback 通过完整版本回滚；不在一个 Turn 混用两个 executor/Hook registries。

### 13.2 `AgentRunner.on()`

`AgentRunner.on()` 不保留为运行期 mutable registration API。Repository callers/tests 迁移为 startup Hook Contributions；新 Runner 只接收 immutable Hook projection。

项目处于明确 Architecture migration，当前无已登记 external caller contract，因此本 Slice不增加长期 Compatibility facade。若 Delivery 前发现必须保留的 repository 外 consumer，必须暂停并将其登记为有 Owner、到期 Slice和 contract test 的单向 startup adapter；该 adapter 不能在 Runner 启动后 mutation，也不能成为新调用方入口。

### 13.3 Provider-shaped Invocation fields 与 Session storage boundary

新的 canonical Model Invocation path 不再使用 wire path `input_schema`、`function.parameters` 或 Provider SDK Tool types，也不再把 malformed arguments 静默转换成空对象。Core-owned invocation Tool Call/Result 使用 `callId`、`name`、decoded input state 和 canonical outcome；Provider Adapter 显式映射。

本 Slice 不借 Provider-neutral invocation migration 重命名 persisted Session record、public `AgentEvent` 或 Channel presentation discriminants。它们是独立的 storage/public contracts，不是 Provider SDK contract。Session-to-invocation mapper 保留当前磁盘兼容并在调用 Provider 前构造 canonical messages。具体规则：

- 既有 Session records 继续可读，不要求离线数据迁移；
- history 必须先映射为 canonical invocation messages，再进入 Provider Adapter；
- Anthropic `role=user + tool_result` 或 OpenAI `role=tool` 不写入 Session Domain 作为 canonical role；
- storage/public event naming 不得被 Provider Adapter 直接透传，也不得反向拥有 Tool Policy/validation；
- Slice 3 不改变 Session schema；canonical outcome 的 durable model-facing representation 继续使用 paired call ID + string content。Recovery content 必须保持 outcome unknown，不猜测 user denial、abort 或 execution success。

这样保留磁盘兼容，同时移除 Model Invocation Port 对单一 Provider wire shape 的依赖，不建立第二 writer、storage migration 或临时双向 Core authority。

### 13.4 Legacy count

Slice 3 起始 Legacy entries 固定为 `CODE-E01` 和 `CODE-E02`：

$$
Legacy_{start}=2
$$

完成目标为两项均 `Migrated`，无隐藏 Flag、第二 executor 或 startup approval Hook：

$$
Legacy_{end}=0<Legacy_{start}=2
$$

CODE-E01 在 Slice 5 仍可能有 Runtime Composition residual wording，但 Slice 3 到期的 central Tool list、Task post-assembly、mutable Tool bundle consumer 和 executor setter 必须在本 Slice退出，不能用 Slice 5 延期保留。

## 14. 删除条件

- central `getDefaultBuiltinTools()` list/`assembleRuntimeTools()` mutable bundle 不再是 production authority；
- `RuntimeApp.create()` 不追加 Task Tool、不重建 definitions/executor、不 mutation `toolBundle`；
- `AgentRunner.setToolExecutor()` 删除；Runner 不接受替换 executor；
- `AgentRunner.on()` mutable registration 和 per-instance registration history 删除；
- `startChannels()` 不安装 approval Hook，authorization 不依赖 Channel startup history；
- Tool definition 只从 canonical Contribution 派生一次；Provider/prompt 不拥有重复 schema；
- denied Tool 在 Provider-visible definitions 中隐藏，runtime explicit deny 仍生效；
- `before_tool_call` 后 effective input 必经 Ajv validation；invalid input 不执行 Tool；
- Anthropic Adapter 进行显式 mapping；Core Model Invocation Tool Contract 不再因字段形状相同而近似透传 wire Tool types；
- OpenAI-compatible pure codec fixtures 通过，无 production SDK/client；
- Hook projection ordering 不依赖 registration order；duplicate identity staging failure；
- after Tool/Compaction observers 都有 5 秒 per-handler bounded settlement，不 detached 越过边界；
- approval 不是 Hook，observer deadline 不影响 approval；
- controlled Abort 在当前 Turn closure，unknown repair 不伪造已知 outcome 或重放；
-完整 Prompt Tool Definition 派生删除；Memory prompt 条件改读窄 tool-name projection；
- External Test Extension 与 Builtin 使用相同 registration/staging path，不能访问 RuntimeApp private state；
- inventory 中 CODE-E01、CODE-E02 对应 Slice 3 residual 为零。

## 15. 验收场景

- **AC-TH-01 Common registration：** Builtin Module 与 External Test Extension 通过同一 API 注册 Tool/Hook；consumer 不按来源分支。
- **AC-TH-02 Atomic staging：** External fixture 任一 Contribution 无效时整组零发布；invalid Builtin 阻止 startup。
- **AC-TH-03 Immutable projection：** Runner 只能读取 Turn-pinned Tool/Hook views，无法 mutation Builder/registry/definitions。
- **AC-TH-04 Portable schema：** 所有 Builtin schemas 属于 v1 profile；unsupported keyword/invalid Schema 在 Provider invocation 前拒绝。
- **AC-TH-05 Provider expressiveness：** Anthropic 与 OpenAI-compatible definitions/calls/result correlation+content fixtures 保持明确列出的 portable shared semantics；Core-only outcome 不参与 wire round-trip；多调用和 interleaved fragments 不串扰。
- **AC-TH-06 Malformed call：** malformed/non-object input 保留 call correlation 并产生 `invalid_input`，不静默使用 `{}`，不执行 before Hook/Policy/Tool；适用的 after observers 仍观察 terminal result。
- **AC-TH-07 Effective validation：** before hooks 顺序变换 input；Ajv 只校验最终 input；失败时 Policy、approval、Tool invocation counts 均为零。
- **AC-TH-08 Stable ordering：** 不同 registration/acquisition 顺序得到相同 Hook order；priority/unit/contribution tie-breaker 可证伪；duplicate identity 拒绝。
- **AC-TH-09 Deny visibility：** explicit deny Tool 不进入 Provider definitions；伪造/旧上下文调用仍由 runtime Policy 分类为 deny。
- **AC-TH-10 Approval separation：** Hook unchanged 不等于授权；approval 不依赖 `startChannels()`；unavailable/failed 不伪装成 user deny。
- **AC-TH-11 Tool observer settlement：** after handlers 并发、逐个 failure-isolated；rejection/5s timeout/late completion 不改变 result，且下一 Model invocation/Turn completion 等待逻辑 settlement。
- **AC-TH-12 Compaction observer settlement：** before/after observers 按 ADR-002 blocking boundary settlement；timeout 后 retry 才可继续，observer 不能改变 candidate/commit。
- **AC-TH-13 Paired outcomes：** success、unknown Tool、invalid、Hook deny/fail、Policy deny、approval outcomes、Tool throw/abort 都产生同 call ID result，并对 current-Turn call 触发一次 after observer。
- **AC-TH-14 Controlled Abort：** real completed result 保留；confirmed cancellation 为 aborted；未启动 calls 为 not-executed；当前 Turn 持久化 closure 后才 settlement。
- **AC-TH-15 Unknown recovery：** crash gap 只补 recovery-only outcome-unknown、不覆盖真实 result、不触发旧 execution Hooks、不自动重放。
- **AC-TH-16 Prompt narrowing：** Prompt 不持有第二份 Tool schema；Memory 条件只读取精确 Tool name/capability。
- **AC-TH-17 Legacy exit：** central list/Task post-assembly/setter/mutable Hook registration/startup approval wiring 零 production references，`Legacy_end=0`。

## 16. 分层验证

### 16.1 Unit / Contract

- portable Schema whitelist/invalid keyword/root/type/required/additionalProperties tests；
- Ajv no-coercion/no-default/no-removal 和 transformed effective input tests；
- Tool/Hook identity、unit atomicity、conflict和 immutable type tests；
- Hook ordering permutation/property table；
- before Hook transform/deny/throw/Abort；
- observer fulfilled/rejected/aborted/timed-out/late completion with fake clock；
- Policy visibility + runtime deny/allow/requiresApproval matrix；
- canonical outcome mapping 与 call correlation；
- Anthropic/OpenAI-compatible codec fixture suite。

### 16.2 Integration / Regression

- Runtime startup → Builtin/External staging → Snapshot → real Parent Runner Tool round；
- optional Task Tool 已在 Snapshot publication 前完成绑定，Parent → Child delegation regression；
- Memory Tool + prompt narrow projection regression；
- current-call approval available/unavailable/Abort without Hook wiring；
- multiple sequential Tool Calls、controlled Abort between calls、nonresponsive started Tool completion；
- Session closure persistence、next-Turn unknown repair 和 Provider-valid history；
- Tool observers block next model/Turn only until bounded settlement；
- Compaction preemptive/overflow retry waits observer settlement；
- existing Usage、Event correlation、Subagent、context budgeting 和 compaction behavior not otherwise changed。

### 16.3 Fitness / Static / Build

- FT-01：Stable Core 不导入 Provider SDK/platform concrete dependencies；
- FT-02：Provider SDK 只在 Adapter/Integration allowlist；
- FT-03：Runner 不依赖 mutable Registry、Config loader、Provider SDK 或 Runtime private state；
- FT-04：Extension/Test Contribution 实现依赖 core-owned contracts；
- FT-06：OpenAI-compatible fixture/新 Tool/Hook 不要求修改 Runner central branch；
- FT-07：Snapshot/Tool/Hook projections 只读，旧 mutable bundle diagnostics 删除；
- FT-08：canonical public contracts 有明确 owner/export；
- FT-09：active docs/links 指向本 Spec；
- deterministic zero-reference audit：`setToolExecutor`、Runtime Task post-assembly、`wireApprovalRouting` Hook install、mutable `hookRegistrations`、duplicate prompt definitions；
- `npm run lint`、相关 Vitest、完整 `npm test`、`npm run build`、document diagnostics、local link audit 和 `git diff --check`。

测试不得依赖真实 Provider 网络、付费调用或 wall-clock 5 秒等待。

## 17. Definition of Ready

- [x] Plan Item、用户可观察结果、范围与非目标已起草；
- [x] ADR-001/002/005/006、Target Architecture 和 AF-04/06 提供 authority/evidence；
- [x] 项目所有者确认 portable schema、deny 双重 enforcement、Hook tie-breaker、5 秒 observer deadline 和 Compaction Hook 收敛方向；
- [x] ownership、依赖方向、Compatibility、Legacy count 和删除条件已起草；
- [x] Anthropic/OpenAI-compatible conversion 只需 pure codec fixture，不依赖外部 SDK/network，因此无需新 Spike；
- [x] AF-06 已验证 common registration/staging/projection 形状；Slice 3 不实现 dynamic lifecycle；
- [x] independent Spec review 无未解决 Critical/High/Medium blocker；
- [x] 项目所有者接受完整 Spec；
- [x] 项目所有者在接受 Spec 后另行批准进入 production Delivery。

未完成最后三项前不得修改 production code或安装 Ajv。

## 18. Definition of Done

- [x] AC-TH-01..17 均有自动化证据；
- [x] 至少一个真实 Parent Tool round 使用新 Snapshot pipeline；
- [x] Builtin 与 External Test Extension contract suites 通过；
- [x] Anthropic/OpenAI-compatible semantic codec fixtures 通过；
- [x] controlled Abort closure 与 Compaction observer settlement 通过；
- [x] CODE-E01/CODE-E02 Slice 3 residual 为零；
- [x] focused/contract/integration/regression/Fitness/lint/full tests/build/docs/diff checks 通过；
- [x] Spec、Current Architecture、Plan、Inventory、ADR follow-up 和文档索引同步；
- [x] independent implementation review 无未解决 blocker；
- [x] 项目所有者接受验证结果并确认 Slice 3 完成（2026-09-08）。

## 19. Open Questions

无 blocking Open Question。Implementation 若发现以下任一事实，必须停止并回到项目所有者：

- v1 portable Schema 任一已允许关键字无法被 Anthropic 或 OpenAI-compatible reference codec 保真表达；
- 历史 Session/public consumers 要求长期保留 Provider-shaped Core/storage authority；
- Task Tool 无法在 Snapshot publication 前绑定而必须恢复 Runner setter/post-bootstrap mutation；
- 5 秒 bounded settlement 无法在不引入 detached side effect 或第二 scheduler 的情况下满足；
- 新 production dependency、layering 或 migration order 超出本 Spec。
