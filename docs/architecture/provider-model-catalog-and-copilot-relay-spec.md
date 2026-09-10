# Provider Model Catalog and Copilot Relay Module Spec

## 1. 状态

- **状态：** Accepted
- **版本：** 0.9
- **日期：** 2026-09-10
- **所有者：** 项目所有者
- **关联 Plan：** [Provider Model Catalog and Copilot Relay Plan](../roadmap/provider-model-catalog-and-copilot-relay-plan.md)
- **关联 Spike：** [Copilot Relay Responses Protocol Spike Spec](copilot-relay-responses-spike-spec.md)
- **关联 ADR：** [ADR-004 Provider/Model Identity and Facts Ownership](adr-004-provider-model-identity-and-facts-ownership.md)、[ADR-005 Extension/Registry Composition](adr-005-extension-registry-runtime-composition.md)
- **关联既有 Contract：** [Model Resolution Module Spec](model-resolution-module-spec.md)、[Runtime Composition Module Spec](runtime-composition-module-spec.md)、[Channel Module Spec](channel-module-spec.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-10 接受本 Spec v0.8，冻结 closed Provider Model Catalog、Copilot Relay Provider Extension、Runtime Catalog Query 和 Channel Runtime Capability binding 的 target contract。该接受不授权 production 修改、dependency 安装、commit 或 push；C1/C2/C3/C4 Delivery 仍需单独授权并分别通过 Gate。

项目所有者于 2026-09-10 授权 C1，并确认 `scripts/` 下现有脚本是待后续逐项处置的非权威 legacy utilities：当前不保证可运行，不参与 C1 contract、Gate 或 broad validation，也不为其保留 Compatibility。C1 不删除或迁移这些脚本；后续使用前必须按当时 active contract 单独评审、迁移或删除。

项目所有者于 2026-09-10 接受 C1 Closed Provider Model Catalog Delivery Gate。C1 实现、Current Architecture 同步、focused/regression validation 与独立只读审计均已完成；该接受不授权 C2、C3、C4、commit 或 push。

在本 Spec 完成对应 Delivery Gate 前，当前源码和既有 Accepted Architecture 仍是实现事实与架构权威；本文中的 interface 和行为描述是 target contract，不得倒推为 current behavior。

现有 ADR-004 已决定 Provider 是模型事实的权威 producer、Model Resolution 拥有 Catalog view 和 per-Turn binding；ADR-005 已决定 typed Capability、统一 Unit staging 和 immutable Snapshot。本 Slice 不改变这些长期决策，因此不新增 ADR；若 Review 要求 Core 拥有远端目录、Channel 直接访问 Provider 或引入 Service Locator，则必须先修订 ADR。

## 2. 目的与用户可观察结果

用户只能从当前 Runtime generation 发布的模型目录中选择模型。CLI 和 Web UI 展示相同目录；direct API、WebSocket 和配置路径即使绕过 UI，也不能调用目录外模型。

调用方只观察结构化 `{ providerId, modelId }` 和可选显示名。具体 Endpoint、API、SDK、是否原生 Streaming、SSE/WebSocket framing、Tool/Image conversion 和 Provider error mapping 全部由 Provider Integration 内部拥有。

Copilot Relay 第一版通过 `/v1/models` 建立目录，并只为声明支持 HTTP `/responses` 的模型提供一个 OpenAI Responses Adapter。

## 3. Scope

- 所有 Provider 发布闭集、不可变的模型目录；
- Registry staging 校验模型目录；
- Model Resolver 对目录成员资格执行统一 fail-closed；
- Runtime 聚合当前 generation 的传输安全目录 DTO；
- Builtin Anthropic Provider 发布静态 Catalog 与精确 deployment facts 对应模型；
- Copilot Relay 作为 in-repo external Unit，经现有 `loadedUnits` 和统一 Registry path 接入；
- Relay Unit 创建期获取并冻结 `/v1/models`；
- Relay 使用 HTTP `/responses` 实现 `ModelInvocationPort`；
- Channel 通过统一 typed Runtime Capabilities 取得目录和 Abort 能力；
- CLI、WebSocket 和 Web Client 模型选择迁移；
- default model 缺失、目录外模型、发现失败和协议失败语义。

## 4. Non-goals

- Extension 自动发现、安装、Marketplace、独立 npm SDK、manifest/package compatibility contract 或通用 Config Namespace；这些能力后续作为独立 acquisition/delivery Spec 冻结，本 Slice 只保留兼容边界，不预建实现；
- Runtime/Core 理解 `/responses`、`supported_endpoints`、Streaming 或 Relay 原始 Metadata；
- `/chat/completions`、Anthropic Messages、Realtime、`ws:/responses` 或 Embeddings；
- REST API 或第二个管理 Server；
- Catalog 后台刷新、TTL、轮询、跨 generation 原地更新；
- 第一版执行图片数量/大小、reasoning、structured outputs 或 parallel Tool limits；
- 向普通调用方公开 Token facts、Endpoint、Protocol、通用 Provider/Model availability 状态或原始 Provider policy；`defaultSelection` 只描述 configured reference 对 current Catalog 的解析结果；
- Session 历史跨 Provider 转换、旧 Tool ID 修复或 Session 格式迁移；
- 静默 Provider fallback、品牌猜测或自动选择目录第一项。

## 5. Ownership 与依赖方向

| 概念 | 权威所有者 | 消费者 | 禁止责任 |
|---|---|---|---|
| Relay 原始 Metadata 与筛选 | Copilot Relay Extension | Relay 私有 Catalog builder | Runtime、Channel、Core 不解释 Relay Schema |
| Provider 私有模型 Map | 每个 Provider instance | Provider Catalog projection、`resolveModel()` | Channel/UI 不访问 |
| Provider Catalog contract/view | Core Model Resolution | Registry、Resolver、Runtime DTO projection | 不持有 SDK/credential |
| Registry membership/generation | Runtime Composition | Runtime、Turn capture | 不远程刷新 Provider |
| Model Reference validation | Model Resolver | direct/queued Parent 与 Child paths | Channel 校验不成为执行权威 |
| Public Model Catalog DTO | Runtime Application | Channel Runtime Capability | 不暴露 invocation binding 或 raw facts |
| CLI/Web 模型选择状态 | 对应客户端/Channel instance | `ChannelRunRequest.modelReference` | Runtime 不保存全局“当前 UI 模型” |
| API/Streaming/Tool/Image mapping | Provider Adapter | Core `ModelInvocationPort` | Runner 不分支识别 Provider |
| Extension acquisition | 第一版 Host Composition Root；未来可替换为 package loader | Runtime Unit Catalog 接收 deterministic `LoadedRuntimeUnit[]` | RuntimeApp、Runner、Registry、Channel 不发现 package 或解释 manifest |

依赖方向保持 Provider/Extension → Core contracts；Runtime 只聚合 Registry Snapshot 的传输安全 projection；Channel 只依赖 Core-owned Capability contract。不得把 `RuntimeApplication`、Registry Snapshot、Provider entry 或 Service Locator 注入 Channel。

## 6. Provider Model Catalog Contract

### 6.1 Provider entry

每个 `ProviderProjectionEntry` 必须发布：

```ts
interface ProviderCatalogModel {
  readonly modelId: string;
  readonly displayName?: string;
}

interface ProviderProjectionEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly models: readonly ProviderCatalogModel[];
  readonly protocol: string;
  readonly invocationPort: ModelInvocationPort;
  resolveConnection(): ProviderConnectionResult;
  resolveModel(modelId: string, connection: ProviderConnection): ProviderModelResult;
}
```

`models` 是 Provider 在该 instance/generation 中愿意执行基本文本请求的完整闭集。空目录使该 Provider 无可执行模型，但不单独扩大为新的 Provider availability 状态。

Registry staging 必须拒绝：

- 空白或无效 `providerId` / `modelId`；
- 同 Provider 内 duplicate `modelId`；
- 缺失模型目录的旧 Provider entry。

Registry staging 不信任外部 Unit 是否预先冻结 projection。它必须校验后 defensive copy 每个 model entry 和数组，并冻结规范化后的 nested entries、`models` 数组和 Provider projection，再允许进入 Candidate/Snapshot。不得只做浅层 `Object.freeze(provider)`，也不得因调用方传入 mutable source object 而把冻结责任外包给 Extension。

Defensive copy/freeze 的边界是公开 model entries、`models` 数组和 Provider projection shell；`invocationPort` 与 `resolveConnection()` / `resolveModel()` function bindings 仍由发布它们的 Provider Unit instance 拥有，不递归冻结其私有对象图，也不转移 resource/lifecycle ownership。Catalog projection、Resolver binding 和 Invocation binding 必须来自同一个 staged Provider instance 及其同一不可变私有模型 Map。

`displayName` 只用于显示；缺失时调用方回退到 ID。任何 lookup、policy 或 execution 不使用显示名。

### 6.2 单一 Provider 私有事实源

Provider 必须从同一个不可变私有模型 Map 同时产生：

1. 公开的 `models` 目录；
2. `resolveModel(modelId)` 的 Descriptor/Facts。

不得维护一个 UI list 和另一个可执行 model switch。Provider 可以私下保留比公共 Catalog DTO 更丰富的 metadata，但不能让目录成员与 `resolveModel()` 接受集合漂移。

### 6.3 Model Resolver closed-set rule

Model Resolver 在任何 Provider network invocation 前执行：

1. 规范化结构化 Model Reference；
2. 查找 exact Provider；
3. 校验 exact `modelId` 属于该 Provider 的 `models`；
4. 解析 Connection；
5. 调用该 Provider 的 `resolveModel()`；
6. 校验 identity、protocol、facts、policy 和 request requirements；
7. 构造 immutable per-Turn `ResolvedModel`。

目录外模型返回现有 `model_rejected`，不调用 Invocation Port，不猜测 Provider，不换 Provider，不选择第一项。

Channel/UI 的目录检查只用于即时反馈，不能替代 Resolver 的执行检查。

Catalog membership 只表达基本执行资格，不引入 `catalogEligible`、`executionEligible` 或 `requestEligible` 等公开状态。Tool、Image 和其他具体 Turn requirements 继续由 Provider-neutral Facts 与 Model Resolver 在每次请求上校验；不具备基本执行 facts 的模型不得进入 Catalog。

## 7. Public Runtime Model Catalog

Runtime Application 提供一个原子查询：

```ts
interface ModelCatalogEntry {
  readonly modelId: string;
  readonly displayName: string;
}

interface ProviderCatalogEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly models: readonly ModelCatalogEntry[];
}

type DefaultModelSelection =
  | Readonly<{ state: 'unset' }>
  | Readonly<{ state: 'available'; reference: ModelReference }>
  | Readonly<{
      state: 'unavailable';
      reference: ModelReference;
      reason: 'provider_unregistered' | 'model_rejected';
    }>;

interface ModelCatalogSnapshot {
  readonly generation: number;
  readonly defaultSelection: DefaultModelSelection;
  readonly providers: readonly ProviderCatalogEntry[];
}

interface RuntimeApplication {
  getModelCatalog(): ModelCatalogSnapshot;
}
```

`DefaultModelSelection` 不是通用 Provider/Model availability API。它只投影一个已配置默认引用相对于查询 generation 的 exact membership 结果；Catalog 内其他条目仍不携带 availability 状态。

语义：

- 返回值深度冻结、传输安全，不含函数、Port、credentials、facts provenance 或 Provider Metadata；
- `providers` 顺序沿用 published Registry Snapshot 的 deterministic order；模型顺序由 Provider 冻结并保持稳定；
- `generation` 是目录所属 current Registry generation；
- 未配置 default 时 `defaultSelection.state === 'unset'`，不得隐式选择第一项；
- configured default 属于 current Catalog 时状态为 `available`；不属于时状态为 `unavailable`，保留原引用并以 `provider_unregistered` 或 `model_rejected` 解释原因；
- unavailable default 不阻断 Runtime startup、不修改持久配置、不触发 Provider fallback；用户仍能查询其余 Catalog 并选择 explicit model；
- Provider Extension 后续恢复并重新发布相同引用时，新 generation 中该 default 自动恢复为 `available`；
- 查询只读取 current Snapshot，不触发网络、refresh 或 paid probe。

所有模型事实仍只供内部 Model Resolver 使用。UI 若未来需要稳定 capability badges，必须另行扩展 Provider-neutral DTO，不转发 Relay Schema。

## 8. Default Model 与配置

长期默认引用使用结构化 `{ providerId, modelId }`。C1 将 `ModelReference.providerId` 收紧为 required，并删除 string reference 与 `defaultProviderId` 补全路径：

```ts
interface ModelReference {
  readonly providerId: string;
  readonly modelId: string;
}
```

本 Slice 将当前仅含 model string、依赖第一 Provider 的 Compatibility input 原子迁移到 `AgentDefaults.model?: ModelReference`；`LLMConfig` 只保留连接、token policy 和 deployment facts，不再拥有模型选择：

```ts
interface AgentDefaults {
  readonly model?: ModelReference;
  readonly llm: LLMConfig;
  // existing fields omitted
}
```

Config JSON 使用：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "providerId": "copilot-relay",
        "modelId": "gpt-5.6-sol"
      }
    }
  }
}
```

该 `model` 字段可省略；它不是 Relay 启用或连接所必需的配置，只为未携带 explicit Model Reference 的 Turn 提供 Runtime default。省略后 Runtime 仍可启动，但此类 Turn 按下述规则以 `reference_invalid` 失败。

`agents.list[].model` 沿用现有 per-agent override merge。环境变量使用 `MY_AGENT_PROVIDER` 与 `MY_AGENT_MODEL` 这一对字段形成同一个结构化引用；只设置其中一个是配置错误，不从目录或第一 Provider 补齐另一半。

配置 precedence 固定为 hardcoded baseline → file `agents.defaults` → matching `agents.list[]` override → environment override → CLI config override；per-Turn explicit `ModelReference` 不参与配置 merge，而是在 invocation 时优先于 merged default。`agents.list[].model` 省略时继承 defaults，提供时必须是完整结构化引用；第一版不以 `null`、空字符串或 partial object 表示 per-agent clear。`MY_AGENT_PROVIDER` / `MY_AGENT_MODEL` 在 config resolution 阶段作为一对原子校验，任一侧单独存在即失败。任何层出现 legacy `llm.model` 都先报告迁移错误，不与新 `model` 比较 precedence。

公共语义如下：

- default Model Reference 完全可选；语法无效或只含 Provider/Model 一侧仍是 config validation error；
- 无 default 时 Runtime 可以启动，Catalog 的 `defaultSelection` 为 `unset`；
- 没有 per-Turn explicit reference 且没有 default 时，Turn 在 Invocation 前以 `reference_invalid` 失败；
- configured default 在 current Catalog 外时 Runtime degraded startup，Catalog 的 `defaultSelection` 为 `unavailable`；没有 per-Turn explicit reference 的 Turn 在 Provider invocation 前以对应 `provider_unregistered` 或 `model_rejected` 失败；
- unavailable default 不被删除或重写，Extension/Model 恢复后可重新生效；
- `/model default` 清除 CLI override；若 Runtime default 缺失，effective model 为空；
- 不跨 Provider fallback，不按 Catalog 顺序选择模型。

迁移在 C1 原子完成：配置文件中的 `llm.model` 被拒绝并给出迁移诊断，不做静默 rewrite；原有单独 `MY_AGENT_MODEL` 推断第一 Provider 的语义删除。实现、Schema、Wizard、examples 和 tests 同批迁移，不保留一次性读取器或两个默认模型权威。

## 9. Copilot Relay Extension

### 9.1 Unit 与 composition

第一版是 in-repo external Unit，例如：

```text
src/extensions/copilot-relay-provider/
├── copilot-relay-provider-unit.ts
├── copilot-relay-provider.ts
├── responses-client.ts
├── model-metadata.ts
├── types.ts
├── index.ts
└── *.test.ts
```

Factory：

```ts
interface CopilotRelayProviderUnitOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly discoveryTimeoutMs?: number;
}

createCopilotRelayProviderUnit(
  options: CopilotRelayProviderUnitOptions,
): LoadedRuntimeUnit
```

配置语义：

- `baseURL` 默认 `http://127.0.0.1:5000`；Unit 私有 client 在使用前校验并规范化 trailing slash；
- `apiKey` 可选；缺失或仅含空白时不发送 `Authorization`；
- `discoveryTimeoutMs` 默认 5 秒，只约束创建期 `/v1/models` discovery，不定义 Turn invocation timeout；
- Host bootstrap 可以读取 `COPILOT_RELAY_BASE_URL` 和 `COPILOT_RELAY_API_KEY`，再显式构造 Unit options；第一版不为 discovery timeout 增加环境变量；
- Extension 不读取 `process.env`、全局 `AppConfig` 或 Runtime private state；Relay base URL、credential 和 discovery timeout 不进入 Agent/default model 配置；
- Host 是否把 Relay Unit 放入 `RuntimeAppOptions.loadedUnits` 是唯一启用控制，不增加 `enabled` 配置或第二个启用权威。

Host 显式通过 `RuntimeAppOptions.loadedUnits` 组合它。Runtime、Runner 和 Registry 不增加 Relay-specific branch。Extension discovery/installation 不在本 Slice。

此处 `bundled` 只表示 Relay 第一版由仓库内代码取得；其 Runtime Unit metadata 仍为 `source: 'external'`、`required: false`，并使用通用 external Unit failure isolation 与 lifecycle，不引入 bundled-only Unit category。

### 9.1.1 Future acquisition compatibility

第一版的 `src/extensions/copilot-relay-provider/` 路径和 direct factory import 只是 in-repo acquisition convention，不是公共 SDK、package ABI 或未来安装目录 contract。Relay 的 runtime identity、registration 和执行行为不得依赖源码路径。

后续若增加独立 package、manifest、discovery 或 loader，必须满足：

- acquisition 由 Composition Root / Runtime Builder 边界拥有；loader 可以产生 acquisition diagnostics，但进入 Runtime composition 的唯一可执行产物是经过 loader-side package/compatibility validation、顺序确定的 `readonly LoadedRuntimeUnit[]`；
- packaged 与 in-repo external Unit 在 acquisition 后使用同一个 `RuntimeUnitCatalog`、`create(signal)`、registration staging、conflict isolation、immutable Registry Snapshot、generation pin、retirement 和 lifecycle ownership path；
- loader 不直接调用 `ExtensionRegistrationApi`、修改 Registry、启动 Extension resource，或向 Extension 暴露 Runtime private state；
- `unitId` 是稳定 Runtime identity，不由 package version、installation path、源码路径或 filesystem enumeration order 派生；Relay Unit 的 `unitId` 必须与 `RuntimeUnitInstance.registration.id` 相同，registration source 保持 `external`；
- package name、version、installation path 和 discovery provenance 如未来需要，只作为 acquisition diagnostic metadata；不得替代 `unitId`，也不得进入 Core execution contracts；
- Core、RuntimeApp、Runner、Registry、Model Resolver 和 Channel 不增加 package-specific 或 Relay-specific branch，不建立第二个 registration、lifecycle 或 Provider execution path。

本兼容边界不冻结 manifest schema、package format、公共 Extension SDK、version negotiation、discovery algorithm、installer、sandbox、Marketplace 或通用 Extension Config Namespace；这些内容必须由存在真实独立 package consumer 时的独立 Spec 决定。

### 9.2 Discovery timing

`LoadedRuntimeUnit.create(signal)` 执行有界 `/v1/models` discovery、Schema validation 和 immutable private Map 构建，再返回具有固定 registration 的 instance。这样 registration staging 前目录已完整，`start()` 不修改已注册 projection。

Discovery：

- 遵守 create `AbortSignal`；
- 同时受 `discoveryTimeoutMs` 约束，省略时使用 5 秒默认值；Abort 或 timeout 都必须取消底层请求并按 Unit create failure 收敛；
- 不重试或后台刷新，除非 R0 证据要求一个有界 transport retry；
- HTTP/JSON/Schema 失败导致该 external Unit create 失败；
- Relay Unit 按 optional external Unit 组合；失败隔离遵循现有 optional external Unit policy，不污染 current generation；
- discovery 失败时不发布 Relay Provider，Runtime 继续以其余 current Catalog degraded startup，并通过 bounded startup diagnostic 报告失败；
- configured default 指向未发布的 Relay Provider/Model 时保留为 `unavailable` 用户偏好；不得阻断用户查询 Catalog、不得静默改用其他 Provider；
- reload candidate 的 Relay create 失败不得替换 current generation；diagnostic 进入 candidate/startup report，不新增 Relay 专属错误体系；
- 不使用旧缓存、静态 Relay model list 或任意模型 fallback。

### 9.3 Relay model eligibility

第一版只保留满足以下条件的 entry：

- `id` 是非空字符串；
- `supported_endpoints` 包含 exact HTTP `"/responses"`；
- `capabilities.limits.max_output_tokens` 是正整数；
- `max_prompt_tokens` 或 `max_context_window_tokens` 至少一个是正整数，可形成保守 prompt/context fact。

不以 `capabilities.type`、`model_picker_enabled`、`supports.streaming`、vendor、family、preview 或 policy 字段作为公共筛选条件。Provider 可以原生流式或在内部把非流式完整响应投影为 Core stream events；调用方不观察该差异。

第一版私有 metadata 最多保留：

```ts
interface RelayModelMetadata {
  readonly id: string;
  readonly displayName?: string;
  readonly vendor?: string;
  readonly version?: string;
  readonly maximumPromptTokens: number;
  readonly maximumOutputTokens: number;
  readonly toolUse?: boolean;
  readonly vision?: boolean;
  readonly supportedImageMediaTypes: readonly string[];
}
```

Provider Facts 投影：

- `effectiveContextLimit = min(valid max_prompt_tokens, valid max_context_window_tokens)`；只有一个有效值时使用该值；
- `maximumOutputTokens = max_output_tokens`；
- `toolUse = supports.tool_calls`（存在时）；
- `mediaKinds = ['image']` 仅当 `supports.vision === true` 且支持的 MIME 与 Core image MIME 交集非空；
- 来源统一为 `provider-metadata`。

忽略 `max_prompt_images`、`max_prompt_image_size`、parallel calls、reasoning、structured outputs、tokenizer、terms 和 warning text。Relay 仍可因未建模约束返回 normalized Provider error，这是第一版已知限制。

### 9.4 Responses Adapter

R0 [Spike Results](copilot-relay-responses-spike-results.md) 在本地 Relay 与 `gpt-5.6-sol` 上支持 `Provisional Pass`。第一版选择原生 `fetch` + Extension 私有 bounded SSE parser，不增加 OpenAI SDK dependency。SDK custom base URL 路径因当前项目未安装 SDK 且 dependency 安装未获授权而 Deferred；这不阻塞 raw HTTP 方案。

Adapter 必须把 Core contract 映射为 Responses protocol：

- system instruction；
- user/assistant text history；
- image input；
- function tool definitions；
- function call and function call output correlation；
- text deltas、complete Tool Calls、stop reason 和 Usage；
- AbortSignal；
- Provider errors → Core normalized errors和脱敏 diagnostics。

Adapter 对 Runner 只实现 `ModelInvocationPort`。Endpoint、stream choice、response IDs、item IDs 和 SDK objects 不越过 Extension boundary。

#### 9.4.1 Request mapping

Adapter 向 `${baseURL}/v1/responses` 发送 JSON：

| Core semantic | Responses request mapping |
|---|---|
| Model | `model` |
| Output limit | `max_output_tokens` |
| System instruction | `instructions` |
| User text | ordered `input` message with `role: 'user'` and `content[].type: 'input_text'` |
| Assistant text history | ordered `input` message with `role: 'assistant'` and `content[].type: 'output_text'` |
| Image | user content `{ type: 'input_image', image_url: 'data:<media-type>;base64,...' }` |
| Tool definition | `{ type: 'function', name, description, parameters: inputSchema }` in `tools` |
| Historical Tool Call | stateless `{ type: 'function_call', call_id, name, arguments }` input item |
| Tool Result | `{ type: 'function_call_output', call_id: tool_use_id, output: content }` |
| Streaming | `stream: true`；non-stream `chat()` 可使用相同 mapping 后收集完整 response |

第一版使用 stateless history replay，不依赖 Relay response storage 或 `previous_response_id`。R0 中单独使用 `previous_response_id` 回传 Tool output 被 Relay 以 HTTP 400 拒绝，而重放完整 `function_call` 并追加相同 `call_id` 的 `function_call_output` 成功。

#### 9.4.2 SSE and Core event mapping

Text path 的实测顺序为：

```text
response.created
response.in_progress
response.output_item.added (message)
response.content_part.added
response.output_text.delta × N
response.output_text.done
response.content_part.done
response.output_item.done
response.completed | response.incomplete
```

Adapter 投影：

- 首个 `response.created` → 一个 Core `message_start`；
- 每个 `response.output_text.delta.delta` → 一个 Core `text_delta.text`；
- `response.completed` / `response.incomplete` 按 §9.4.4 产生一个 Core `message_end`；
- `response.failed` 或 SSE `error` → normalized Core `error`，不产生成功 `message_end`；
- 未知非 terminal event 第一版可忽略；未知 terminal event、缺失 terminal 或重复 terminal 必须 fail closed 为 normalized Provider error。

#### 9.4.3 Tool Call and correlation

Tool path 的实测顺序为：

```text
response.output_item.added (function_call)
response.function_call_arguments.delta × N
response.function_call_arguments.done
response.output_item.done (function_call)
response.completed
```

`response.output_item.done.item` 提供完整 `call_id`、`name` 和 JSON string `arguments`。Adapter 在该事件到达时解析 arguments 并只发出一个 complete Core `tool_call`：

- Core `ToolCall.callId = item.call_id`；
- `name = item.name`；
- object JSON 映射为 ready input；malformed JSON 或非 object 沿用 Core 现有 invalid input state；
- duplicate/blank `call_id` 或 blank name 按 Provider protocol error fail closed。

R0 观察到 arguments deltas 拼接后等于 done arguments，但 Relay 的 `item.id` 和 arguments delta `item_id` 在同一次调用内不稳定，且各 delta 的 `item_id` 也可能不同。Adapter 不得用 `item_id` 关联、持久化或生成 Core Tool identity，并以每个 `response.output_item.done` 的完整 item 作为 Core emission authority。单 Tool sample 中 `output_index` 保持稳定，但 parallel Tool behavior 未取证且仍是第一版非目标，不据此冻结并行关联算法。

Tool result follow-up 只使用 Relay 返回的 `call_id`。Core 历史 `tool_use.id` 保存该值，后续 `function_call` 和 `function_call_output` 使用相同 `call_id` stateless replay。

#### 9.4.4 Terminal, stop reason and Usage

| Responses terminal | Core projection |
|---|---|
| `response.completed`，未产生 Tool Call | `message_end { stopReason: 'end_turn' }` |
| `response.completed`，已产生一个或多个 Tool Call | `message_end { stopReason: 'tool_use' }` |
| `response.incomplete` 且 `response.incomplete_details.reason === 'max_output_tokens'` | `message_end { stopReason: 'max_tokens' }` |
| `response.failed`、SSE `error`、未知 incomplete reason | normalized Core `error`；无成功 `message_end` |

Streaming Usage 只从 terminal event 的 `event.response.usage.input_tokens` / `output_tokens` 读取并随唯一 `message_end` 发出一次。Non-stream Usage 从 top-level `response.usage` 读取。`total_tokens`、detail fields 和 Relay-specific `copilot_usage` 第一版不进入 Core contract。

`response.completed` 或已识别的 max-token `response.incomplete` 若缺失有效非负整数 `input_tokens` / `output_tokens`，按 normalized Provider protocol error fail closed，不发送 `message_end`。

#### 9.4.5 Abort and resource settlement

同一个 Core `AbortSignal` 传给 `fetch` 并约束 response body consumption。R0 观察：

- request 发起后、首个 content 前 Abort 在约 5 ms 内以 AbortError settled，successful terminal count 为 0；
- 首个 `response.output_text.delta` 后 Abort 在约 2 ms 内以 AbortError settled，没有观察到 terminal event；
- Adapter 捕获 AbortError 后沿用现有 Core error path，不转换为 Provider failure，不发送 `message_end`；
- reader/body 必须释放，任何后续 SSE event 不再投影。

上述时间是本次环境观察值，不构成通用 SLA；契约要求是有界 settlement 和无 success terminal。

#### 9.4.6 Error extraction and known limits

R0 的 invalid model、invalid max output 和 malformed Tool output 均返回 HTTP 400、`application/json`，body 为 `error.type = 'invalid_request_error'`、`error.message` 和可选 `error.code`。测试失败响应没有 request-id header 或 body field；成功响应包含 `x-request-id` 与 `x-github-request-id`。

Adapter：

- 按 HTTP 400 映射 `ModelInvocationError('invalid_request')`；其他状态沿用 Provider-neutral category mapping；
- 从 bounded `error.type`、`error.message`、可选 `error.code` 以及已知 request-id headers/body field 提取脱敏 diagnostics；request ID 必须可选；
- 不记录 raw response、prompt、base64、Tool input/result 或 schema content；
- 以下是由 Core settlement contract 推导、尚未由 R0 live call 验证的 C2 要求：fixture tests 必须覆盖 malformed frame、partial UTF-8、`[DONE]`、重复/乱序 terminal 和 terminal 前 early close；
- 多图、图片大小、parallel Tool Calls、structured output、reasoning policy、background response、response storage 和 WebSocket Responses 仍是第一版非目标。

项目所有者已于 2026-09-10 确认 R0 Results，并随后单独接受本 evidence-based mapping。R0 确认与 Module Spec 接受是两个独立控制点，均不授权 production Delivery。

## 10. Channel Runtime Capability Binding

### 10.1 统一绑定入口

以一个统一入口承载显式、窄小、强类型能力：

```ts
interface ModelCatalogQuery {
  getSnapshot(): ModelCatalogSnapshot;
}

interface TurnAbortCapability {
  querySessionsNeedingAbort(): string[];
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
}

interface ChannelRuntimeCapabilities {
  readonly modelCatalog: ModelCatalogQuery;
  readonly abort: TurnAbortCapability;
}

interface ChannelInstance {
  bindRuntimeCapabilities?(capabilities: ChannelRuntimeCapabilities): void;
}
```

约束：

- `ModelCatalogQuery` 由 Runtime Composition 基于唯一 current Registry Snapshot access 构造并交给 Runtime/Channel binding；Channel 不创建、不缓存 Registry 或 Provider projection；
- Runtime 在 `ChannelInstance.start()` 前同步绑定；
- capability object 与 nested Ports 冻结；
- 每次 `getSnapshot()` 同步读取调用线性化点上的 current published generation，并返回由该 immutable Registry Snapshot 投影或缓存的深度冻结 DTO；不得返回 candidate、partial generation 或 mutable source reference；
- query 不 acquire generation pin、不触发 Provider/Extension code 或 I/O，也不等待 retirement；同一长期 Channel binding 在 publish 后的下一次查询自动观察新 generation；
- 不传 `RuntimeApplication`、Registry、Provider entries 或 arbitrary token lookup；
- 一个绑定入口可以增加经过 Spec 接受的 typed Capability Port，但不是 Service Locator；
- Query 与有副作用 Command 即使共用绑定入口，仍放在不同 nested Port；
- 当前 `bindAbortHooks()` 被替换并删除，不保留双绑定路径。

### 10.2 CLI

CLI instance 持有可选 `selectedModelOverride: ModelReference`，提供本地命令：

```text
/models
/model
/model <providerId> <modelId>
/model default
```

- `/models` 按 Provider 分组显示 current Catalog，标记 default 和 override；
- `/model` 显示 override、default selection state、effective model；unavailable default 必须显示原引用和原因；
- `/model <providerId> <modelId>` 必须属于当前 Catalog，否则只输出本地错误且不发 Turn；
- `/model default` 清除 override；default 缺失时允许 effective model 为空，default unavailable 时显示不可用状态并允许用户随后选择其他 override；
- 普通输入携带当前 override；无 override 时不携带 Model Reference；
- slash commands 不进入 Session、不发送给 LLM；
- Catalog generation 变化后，旧 override 在下一次命令/发送时重新检查，Resolver 仍是最终权威。

### 10.3 WebSocket

第一版使用已有 WebSocket connection，不增加 REST。

Client → Server：

```json
{ "type": "get_model_catalog", "request_id": "catalog-1" }
```

Server → Client：

```json
{
  "type": "model_catalog",
  "request_id": "catalog-1",
  "catalog": {
    "generation": 12,
    "default_selection": {
      "state": "unavailable",
      "reference": {
        "provider_id": "copilot-relay",
        "model_id": "gpt-5.6-sol"
      },
      "reason": "provider_unregistered"
    },
    "providers": []
  }
}
```

- 业务查询必须在成功 `hello` 后发送；
- `request_id` 是 client-scoped 非空关联 ID，Server 原样返回；
- 查询单播，不广播、不加入 Session audience、不产生 AgentEvent；
- Catalog 缺失或 Runtime 未绑定返回现有 `SERVER_NOT_READY`；
- malformed request 返回 `INVALID_MESSAGE`；
- Web Client 在 `hello_ack` 后主动查询，并用 Provider/Model selector 替换自由文本模型输入；
- Web Client 收到 unavailable default 时显示原引用和原因，同时保持 Catalog selector 可用；不得自动选择或提交第一项；
- `run_turn.model_reference` 继续携带结构化引用；不发送时表示使用 Runtime default，而非 UI 第一项；
- Catalog 不塞入 `hello_ack`，避免握手与目录演进耦合。

新增 Catalog wire message 及其 nested payload 使用 snake_case，TypeScript 内部仍使用 camelCase DTO，并在 Channel boundary 显式转换。既有 WebSocket 消息的 mixed-case 字段保持不变；本 Slice 不重命名既有字段，也不升级协议版本。后续若要统一整个 wire contract，必须作为独立兼容性变更设计。

## 11. Lifecycle、一致性与并发

- Provider Catalog 是 Registry Snapshot 的一部分，与 Provider Invocation binding 同 generation 发布；
- Root Turn 在既有 dequeue/start transition 捕获 generation；Model resolution 和 execution 使用该 generation；
- `getModelCatalog()` / `ModelCatalogQuery.getSnapshot()` 返回查询线性化点上 current generation 的完整原子 DTO；其线性化点是同步读取唯一 current Snapshot pointer；
- `commitPublish()` 的同步 current-pointer switch 与同步 Catalog query 在 JavaScript event loop 中不能交错：query-before-publish 返回 N，publish-before-query 返回 N+1；不得观察 candidate 或混合 projection；
- reload 发布新 generation 后，新查询返回新目录，旧 in-flight Turn 不切换；
- Channel model selector 状态不是 Runtime global state；不同 CLI/Web clients 可以选择不同引用；
- Catalog query 不阻塞或中止 Turn，不触发 Provider I/O；
- startup publish 成功前不交付 `RuntimeApplication`，Channel 也不获得 capability；未绑定 Channel 使用 §10/§12 的 `SERVER_NOT_READY` 或本地不可用行为；
- Runtime 进入 closing 后，已绑定 query 在 Channel stop 前仍可返回最后一次成功发布的 current Catalog DTO，不创建新 generation 或延长任何 pin；Channel stop 后继续调用该 Port 不属于受支持行为；
- Relay discovery 只在 candidate Unit create 中发生，失败遵循 candidate cleanup 与 no-publication 规则。

## 12. Errors

| 场景 | 行为 |
|---|---|
| Provider 不存在 | `provider_unregistered` |
| Model 不在 Provider Catalog | `model_rejected`，Invocation Port 未调用 |
| 无 explicit/default model | `reference_invalid` |
| configured default 不在 current Catalog | degraded startup；Catalog 返回 unavailable 原引用/原因；无 explicit model 的 Turn 在 Invocation 前失败 |
| Relay discovery transport/HTTP/JSON/Schema 失败 | startup 隔离 optional Unit 并发布其余 Catalog；reload candidate 失败时 current generation 不变 |
| Relay model metadata 缺必要 facts | 不进入 Relay Catalog；记录 bounded startup diagnostic count，不记录原始 terms/content |
| Responses HTTP 400 / invalid request | `ModelInvocationError('invalid_request')`；读取 bounded `error.type/message/code`，request ID 可选 |
| Responses failed/error、未知 terminal、缺失或重复 terminal | normalized `ModelInvocationError`；无成功 `message_end` |
| Responses AbortError | 沿用 AbortError Core error path；无 `message_end` |
| Channel 未绑定 Catalog capability | `SERVER_NOT_READY` 或 CLI 本地不可用提示 |
| stale Web/CLI selection | Channel 可提前提示；Resolver 必须最终返回 `model_rejected` |

错误不得包含 API key、Authorization、prompt、image base64、Tool input/result、完整 raw response 或 Provider terms。

## 13. Security and Capabilities

- Relay credentials、base URL 和 discovery timeout 只进入 Host 构造的 Extension options/private client，不进入全局 `AppConfig`、Runtime DTO 或 Agent default model 配置；
- 第一版 `baseURL` 只接受无 URL credentials、query 或 fragment 的 `http:`/`https:` loopback URL，并规范化 trailing slash；其他 URL 在发起 discovery 前拒绝；
- `apiKey` 缺失或仅含空白时不发送 `Authorization`；credential 不得进入 Catalog、错误、日志或 startup diagnostic；
- `/v1/models` 返回内容按不可信外部输入做 bounded Schema validation；
- public Catalog 只含 ID/display name，不转发 policy terms、warning、vendor URLs 或 arbitrary metadata；
- Model/Provider display strings在 CLI/HTML 中按文本渲染，不作为 HTML；
- Channel 只获得 `modelCatalog` 和 `abort` typed capabilities；
- WebSocket 沿用当前单信任域，本 Slice不新增远程认证承诺；若 Server 对非 loopback 开放，认证属于独立安全 Slice。

## 14. Compatibility and Migration

### 14.1 Delivery migration matrix

| Gate | Current production/test surfaces | 唯一 Target | 删除与完成条件 |
|---|---|---|---|
| C1 Provider Catalog | `core/model-resolution/types.ts`、`ModelResolver.ts`、`runtime/registry-builder.ts`、Builtin Anthropic Provider 及对应 Fake/tests | required、规范化、深度冻结的 closed `models`；Resolver 在 connection/invocation 前检查 exact membership；Anthropic 只发布 static Catalog 与 exact `deploymentFacts` 可证明的模型 | 所有 Provider/Fake 同批迁移；缺 Catalog、duplicate/invalid ID、mutable nested source 和目录外 invocation contract tests 通过；不存在接受任意 custom model 的 Provider/Resolver 分支 |
| C1 default/config | `platform/config/types.ts`/`defaults.ts`/`loader.ts`/Wizard；`RuntimeResourceSet.defaultProviderId`；Runtime Builder first-provider assignment 与 `getDefaultProviderId()`；`RuntimeApp` 对 `resolvedConfig.llm.model` 的 fallback；`ModelResolver.normalizeReference(..., defaultProviderId)`；`subagent-orchestration.ts`；`compat/model-resolution/legacy-static-config.ts` 及 tests | `AgentDefaults.model?: ModelReference` 是唯一 default authority；required structured `ModelReference` 直接进入 root/child resolution；Turn explicit reference 保持最高 invocation priority | 删除 `RuntimeResourceSet.defaultProviderId`、Builder first-provider/default getter、Resolver default-provider 参数、`createLegacyStaticModelResolver()`、string/partial reference 和 `llm.model` consumption；legacy field 只允许出现在 migration diagnostics/negative tests；Schema、Wizard、root/child callers、Fake/tests 原子迁移，不保留 dual read 或第一 Provider 补全 |
| C1 Runtime query | `runtime/runtime-composition.ts`、`composition-coordinator.ts`、`runtime-composition-manager.ts`、`RuntimeApp` 与 Runtime tests | Runtime-owned current-generation `getModelCatalog()` / `ModelCatalogQuery`，按 §7/§10/§11 投影 immutable transport DTO | startup、query-before/after-publish、long-lived Channel N→N+1、closing 和 mutation tests 通过；已开始 Turn 仍使用 pinned N |
| C2 Relay | 当前无 Relay Provider；Host/Composition Root 只有通用 `loadedUnits` acquisition | in-repo optional external Relay Unit；raw `fetch` + private bounded SSE parser；`/v1/models` immutable private Map | §15.2 unit/parser/adapter tests 与真实 Relay smoke 通过；direct Relay factory import 只在 Composition Root；无 SDK dependency、package-specific Runtime path 或 disposable Spike artifact |
| C3 Channel binding | `ChannelInstance.bindAbortHooks`、`CliChannel.bindAbortHooks()`、`WebSocketChannel.bindAbortHooks()`、`runtime/channel-lifecycle.ts` 注入点及对应 Fake/tests | 一次性 `ChannelInstance.bindRuntimeCapabilities({ modelCatalog, abort })`，CLI/WebSocket 实现同名 typed binding，并在 `start()` 前同步注入 | 所有 production/Fake/tests 同批迁移，`bindAbortHooks` residual 为零；未绑定、reload 后 query 和 Abort regressions 通过，不保留第二绑定入口 |
| C3 selector/wire | CLI 无 Catalog commands；Web Client `form.model` 自由文本；WebSocket Channel/client/tests | CLI `/models`/`/model`；WebSocket `get_model_catalog`/`model_catalog`；Catalog-driven Provider/Model selector；`run_turn.model_reference` 保持结构化 | 自由文本 model input/producer 删除；hello gate、request correlation、unavailable default、stale selection、escaping 和 direct API fail-closed tests 通过；既有 mixed-case fields 不重命名 |
| C4 convergence | active Current Architecture、Fitness、README/运行脚本中仍描述 current legacy behavior | active architecture、operator docs 与实现一致；historical evidence 保留历史状态 | §15.4 全部通过；exact residual scans 仅剩明确允许的 migration diagnostics/negative tests；不为 example-only 历史片段做机械同步 |

迁移时同步更新全部 production Fake/tests、Config Schema、Wizard、active examples、Current Architecture 与 Fitness。不建立 feature flag、双 Resolver、双 default config、双 Channel binding 或自由输入 fallback；被替代路径及其 Compatibility tests 在对应 Gate 删除。

现有 Session 不保存全局模型选择，因此不迁移 Session 文件。既有历史跨 Provider 可移植性不在本 Slice。

`scripts/` 不是本轮 active example 或 supported process surface。其现有 model/env/runtime usage 可以继续暂存，但不得被 production `src/` 引用、不得进入 C1 typecheck/test evidence，也不得迫使 production contract 保留 `llm.model`、单独 `MY_AGENT_MODEL`、第一 Provider 推断或其他 legacy path。仓库级 residual scan 对 `scripts/` 单独报告而不以零结果作为 C1 Gate；后续脚本工作必须单向迁移到届时 active contract。

Accepted Runtime Composition Spec §4 记录的是 Slice 4 历史迁移 baseline，并明确不是目标 Contract；其 §6.5 canonical intake target 已在 current Runtime/queue/WebSocket source 中交付为 `modelReference` 与 `requestOverride.maxOutputTokens`。旧 `RunTurnParams.model` / request-level `maxTokens` aliases 因此不属于本 Slice 的 current migration。C1/C3 必须保持该 current baseline 及其 negative tests，不得把 `ModelInvocationRequest.maxTokens`、resolved model limits 或 Provider wire `maxTokens` 等合法执行字段误判为 legacy request alias。

### 14.2 Gate validation commands and residual scans

- C1 focused：`npm test -- src/core/model-resolution/ModelResolver.test.ts src/compat/model-resolution/legacy-resolution.test.ts src/runtime/registry-builder.test.ts src/runtime/composition-coordinator.test.ts src/runtime/runtime-composition-manager.test.ts src/runtime/runtime-builder.test.ts src/runtime/RuntimeApp.test.ts src/runtime/RuntimeApp.intake.test.ts src/runtime/subagent-orchestration.test.ts src/platform/config/loader.test.ts src/platform/config/wizard/fields.test.ts src/platform/config/wizard/diff.test.ts`；
- C2 pre-delivery evidence 是已接受的 R0 Results 与 disposable artifact absence；C2 实施创建目标目录和 smoke 后，Gate 命令为 `npm test -- src/extensions/copilot-relay-provider` 与 `npx tsx scripts/test-copilot-relay-live.ts`；smoke 默认只允许 loopback Relay，credential 不进入输出；
- C3 focused：`npm test -- src/adapters/channel/CliChannel.test.ts src/adapters/channel/WebSocketChannel.test.ts src/runtime/channel-lifecycle.test.ts src/runtime/RuntimeApp.test.ts`，并以本地 Web Client browser smoke 验证 Catalog selector、escaping、unavailable default 和 structured submit；
- C4/Fitness：`npm test -- src/architecture-fitness`；C1 broad validation：`npm run lint`、`npm test`、`npm run build`、`git diff --check`；现有 `scripts/` 不属于这些命令的 supported evidence surface；
- C1 deletion scans：`git grep -n "defaultProviderId" -- src clients` 必须无结果；`git grep -n -E "llm\\.model|form\\.model" -- src clients` 只允许已评审的 migration diagnostic/negative-test allowlist；`git grep -n -E "RunTurnParams.*model|maxTokens.*RunTurnParams" -- src` 必须无 legacy request alias，仅合法 Provider/Core limit vocabulary 可保留；`MY_AGENT_PROVIDER` / `MY_AGENT_MODEL` 在 production `src/` 中必须只作为成对 config input，不得再次推断第一 Provider；
- legacy script audit：`git grep -n -E "defaultProviderId|llm\\.model|MY_AGENT_MODEL" -- scripts` 只记录后续 cleanup inventory，不阻塞 C1，且不得据此宣称对应脚本可运行。

## 15. Acceptance and Validation

### 15.1 Core/Registry/Resolver

- [x] 所有 Provider entry 必须有深度冻结且无重复的 Catalog；
- [x] 目录外 Model Reference 在 Invocation 前失败；
- [x] Catalog member 的 identity/facts/invocation binding 原子一致；
- [x] Turn generation pin 保护旧/new Catalog 与 Provider binding 不混合；
- [x] unset default 可启动且无引用发送时明确失败；unavailable configured default degraded startup、可查询改选、无静默 fallback，并可在后续 generation 自动恢复。

### 15.2 Relay Extension

- [ ] `/v1/models` 只纳入 `/responses` entry 和具备必要 facts 的模型；
- [ ] `gpt-5.6-sol` 映射为保守 context/prompt limit、128000 output、Tool/Image facts；
- [ ] Text、Streaming projection、Tool round-trip、Image、Usage、Abort、error normalization 通过；
- [ ] Responses parser fixtures 覆盖 partial UTF-8、malformed frame、`[DONE]`、Tool `item_id` 不稳定、重复/乱序 terminal 和 early close；
- [ ] Tool output 使用 stateless `function_call` + `function_call_output` replay，不依赖 `previous_response_id`；
- [ ] discovery failure 不发布 partial Provider，不污染 current generation；
- [ ] Extension private Metadata/SDK types 不越过边界；
- [ ] Relay-specific direct import 只存在于 Composition Root；源码路径不参与 Unit identity，且 Architecture Fitness 证明 Relay 不被 Core、RuntimeApp、Runner、Registry、Model Resolver 或 Channel 直接依赖；
- [ ] in-repo Relay 进入现有 external Unit staging/lifecycle path；没有为未来 package acquisition 预建第二个 Registry、loader-aware Runtime branch 或 public SDK。

### 15.3 Channel/UI

- [ ] `bindRuntimeCapabilities()` 在 start 前注入，旧 `bindAbortHooks()` 删除；
- [ ] CLI `/models`、`/model`、`/model default` 行为通过；
- [ ] WebSocket query/response correlation、hello gate 和错误路径通过；
- [ ] Web UI 不再自由输入模型，只发送结构化 Catalog member；unavailable default 显示警告但不阻断查询和改选；
- [ ] direct API 绕过 Channel 时仍不能调用目录外模型。

### 15.4 Broad validation

- [ ] Provider、Registry、Model Resolver、Runtime、CLI、WebSocket contract tests；
- [ ] Runtime Composition generation/reload/retirement regression；
- [ ] AgentRunner Tool/Image/Abort/Compaction regression；
- [ ] Architecture Fitness；
- [ ] `npm run lint`、`npm test`、`npm run build`；
- [ ] 真实 Relay smoke；
- [ ] Current Architecture 与实现同步。

## 16. Open Questions

R0 已为 SSE event、Tool correlation、Abort 和 raw HTTP custom base URL 提供 evidence-based mapping；没有剩余技术 Open Question。OpenAI SDK 路径 Deferred，第一版已选择 raw `fetch`，不构成 Module Spec blocker。

[R0 Results](copilot-relay-responses-spike-results.md) 已由项目所有者于 2026-09-10 确认。项目所有者随后评审并于同日接受 §9.4 mapping 与完整 Spec v0.8；没有剩余技术 Open Question。该接受关闭设计 Gate，但不授权 C1/C2/C3/C4 production Delivery。

Relay Unit options、Host/env 命名和 credential 来源已在 v0.4 关闭：Host 读取 `COPILOT_RELAY_BASE_URL` / `COPILOT_RELAY_API_KEY` 并通过 `loadedUnits` 显式组合；Extension 只接收 validated options，不读取环境或全局配置。
