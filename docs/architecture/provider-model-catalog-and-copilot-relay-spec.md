# Provider Model Catalog and Copilot Relay Module Spec

## 1. 状态

- **状态：** Draft
- **版本：** 0.6
- **日期：** 2026-09-10
- **所有者：** 项目所有者
- **关联 Plan：** [Provider Model Catalog and Copilot Relay Plan](../roadmap/provider-model-catalog-and-copilot-relay-plan.md)
- **关联 Spike：** [Copilot Relay Responses Protocol Spike Spec](copilot-relay-responses-spike-spec.md)
- **关联 ADR：** [ADR-004 Provider/Model Identity and Facts Ownership](adr-004-provider-model-identity-and-facts-ownership.md)、[ADR-005 Extension/Registry Composition](adr-005-extension-registry-runtime-composition.md)
- **关联既有 Contract：** [Model Resolution Module Spec](model-resolution-module-spec.md)、[Runtime Composition Module Spec](runtime-composition-module-spec.md)、[Channel Module Spec](channel-module-spec.md)
- **工作流：** [Development Workflow](../development-workflow.md)

本 Spec 冻结 closed Provider Model Catalog、Copilot Relay Provider Extension、Runtime Catalog Query 和 Channel Runtime Capability binding 的候选公共语义。Draft 不授权 production 修改、dependency 安装、commit 或 push。

在本 Spec 被接受并完成对应 Delivery Gate 前，当前源码和既有 Accepted Architecture 仍是实现事实与架构权威；本文中的 interface 和行为描述是 target contract，不得倒推为 current behavior。

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

Extension 内部使用 HTTP `/responses`；是否使用官方 OpenAI SDK 由 R0 Spike 根据 SSE、Abort、Tool 和 custom base URL 证据决定。

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

详细 wire mapping 只有在 R0 Results 确认后才能从 Draft 晋升 Accepted。

R0 Results 必须把下列证据化 mapping 补入本节后，Module Spec 才能接受；字段名和事件名不得预先猜测：

| Core semantic | R0 后必须冻结的 Responses evidence |
|---|---|
| Text delta | exact SSE event type、delta field path、ordering |
| Tool call | item identity、name、arguments accumulation、completion event |
| Tool result follow-up | exact correlation input shape 与 identity lifetime |
| Terminal/stop | terminal event、status 与 Core stop-reason mapping |
| Usage | authoritative event/response field 与单次 emission rule |
| Abort | pre-content/mid-stream settlement、terminal suppression、resource cleanup |
| Error | HTTP/status/type/request-id/message 的脱敏 extraction |

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

- Runtime 在 `ChannelInstance.start()` 前同步绑定；
- capability object 与 nested Ports 冻结；
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
- `getModelCatalog()` 返回查询时 current generation 的完整原子快照；
- reload 发布新 generation 后，新查询返回新目录，旧 in-flight Turn 不切换；
- Channel model selector 状态不是 Runtime global state；不同 CLI/Web clients 可以选择不同引用；
- Catalog query 不阻塞或中止 Turn，不触发 Provider I/O；
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
| Responses invocation 失败 | `ModelInvocationError` + 脱敏 Provider diagnostics |
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

| Current | Target | Gate |
|---|---|---|
| Provider entry 没有 required Catalog；`resolveModel()` 可接受未发布 ID | required、规范化、深度冻结的 closed `models`；Resolver 先检查成员资格 | C1 |
| Builtin Anthropic 允许 string custom model 进入解析 | 只发布 static Catalog 与 exact `deploymentFacts` 可证明的模型 | C1 |
| `llm.model?: string` + 第一 Provider 推断 default | `AgentDefaults.model?: ModelReference`；成对 env override；旧字段明确拒绝 | C1 |
| Runtime 无 public Catalog query | `getModelCatalog()` 返回 generation-scoped transport DTO | C1 |
| 无 Relay Provider | optional in-repo external Relay Unit，经 `loadedUnits` 组合 | C2 |
| `bindAbortHooks()` | `bindRuntimeCapabilities({ modelCatalog, abort })` | C3 原子替换 |
| CLI/Web 模型自由文本或无目录查询 | CLI commands 与 Web selector 只使用 current Catalog | C3 |
| WebSocket 历史 mixed-case wire | 既有消息保持；新增 Catalog 消息使用 snake_case | C3 |

迁移时同步更新全部 Fake/tests、Config Schema、Wizard、examples、Current Architecture 与 Fitness。不建立 feature flag、双 Resolver、双 default config、双 Channel binding 或自由输入 fallback；被替代路径及其 Compatibility tests 在对应 Gate 删除。

现有 Session 不保存全局模型选择，因此不迁移 Session 文件。既有历史跨 Provider 可移植性不在本 Slice。

## 15. Acceptance and Validation

### 15.1 Core/Registry/Resolver

- [ ] 所有 Provider entry 必须有深度冻结且无重复的 Catalog；
- [ ] 目录外 Model Reference 在 Invocation 前失败；
- [ ] Catalog member 的 identity/facts/invocation binding 原子一致；
- [ ] Turn generation pin 保护旧/new Catalog 与 Provider binding 不混合；
- [ ] unset default 可启动且无引用发送时明确失败；unavailable configured default degraded startup、可查询改选、无静默 fallback，并可在后续 generation 自动恢复。

### 15.2 Relay Extension

- [ ] `/v1/models` 只纳入 `/responses` entry 和具备必要 facts 的模型；
- [ ] `gpt-5.6-sol` 映射为保守 context/prompt limit、128000 output、Tool/Image facts；
- [ ] Text、Streaming projection、Tool round-trip、Image、Usage、Abort、error normalization 通过；
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

以下问题在 Spec Accepted 前必须关闭：

1. R0 对 Responses SSE event、Tool item correlation、Abort 和 official SDK custom base URL 的结论，以及据此补入 §9.4 的规范 mapping。

Relay Unit options、Host/env 命名和 credential 来源已在 v0.4 关闭：Host 读取 `COPILOT_RELAY_BASE_URL` / `COPILOT_RELAY_API_KEY` 并通过 `loadedUnits` 显式组合；Extension 只接收 validated options，不读取环境或全局配置。
