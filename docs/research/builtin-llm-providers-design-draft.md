# Built-in LLM Provider 设计草稿

> 状态：非权威研究草稿
> 创建日期：2026-09-18
> 最后更新：2026-09-20
> 范围：将 my-agent 的 Built-in LLM 能力收敛为单 Provider、单上游连接、多 Protocol Client 和人工模型注册
> 约束：本文不授权实现；已建立的 [Active Change Plan](../changes/active/builtin-llm-provider/plan.md)、[Specification](../changes/active/builtin-llm-provider/builtin-llm-provider-specification.md) 和 [ADR-016](../decisions/adr-016-unified-builtin-llm-provider.md) 优先于本文中的历史草案内容

## 1. 背景

my-agent 当前内置 `anthropic-compatible` Provider，并通过 `AnthropicMessagesClient` 调用 Anthropic Messages API。项目已经具备 Provider Registry、ModelResolver、Extension Provider 和统一的 `ModelInvocationPort`。

现代模型服务可能在同一个上游连接中同时提供：

```text
Anthropic Messages
OpenAI Responses
OpenAI Chat Completions
```

协议不是 Provider 身份。同一上游服务也可能通过不同协议暴露不同模型。

与此同时，各供应商模型列表的字段差异很大：

- OpenAI、Groq、SiliconFlow 等列表通常只有 Model ID 和少量标识字段；
- 部分列表混合 Chat、Embedding、Rerank、图像、语音和视频模型；
- 少数服务返回上下文、工具、媒体或支持端点等扩展能力；
- OpenAI-compatible 不代表模型元数据兼容。

因此，本设计不依赖动态模型发现，也不要求用户维护完整模型能力数据库。

## 2. 设计结论

Built-in LLM 采用以下结构：

```text
BuiltinLlmProvider
├─ 一个上游服务连接
│  ├─ baseURL
│  └─ apiKey?
├─ 多个按需创建的 Protocol Client
│  ├─ AnthropicMessagesClient
│  ├─ OpenAIResponsesClient
│  └─ OpenAIChatCompletionsClient
└─ 用户人工注册的 Models
   ├─ modelId
   ├─ protocol
   └─ displayName?
```

Provider Registry 中只有一个 Built-in Provider：

```text
Provider Registry
├─ builtin
└─ Extension Providers...
```

Builtin 同时只连接一个逻辑上游供应商。需要多供应商、多连接、特殊认证或故障切换时，由 Extension Provider 实现。

## 3. 术语

| 术语 | 含义 | 示例 |
|---|---|---|
| Built-in Provider | my-agent 随主程序交付的统一 LLM Provider | `builtin` |
| Upstream Service | Built-in 当前连接的单一逻辑供应商或网关 | SiliconFlow、Copilot Relay、企业 Gateway |
| Protocol | 上游服务提供的一种 Wire API | `anthropic-messages` |
| Protocol Client | 将某种 Wire API 适配为 `ModelInvocationPort` 的实现 | `OpenAIResponsesClient` |
| Model Registration | 用户声明的可用模型及其执行协议 | `{ modelId, protocol, displayName? }` |
| Extension Provider | 通过 Extension 注册的独立 Provider | Bedrock、Vertex、自定义 OAuth Provider |

“上游供应商”表示一个 Endpoint 和凭据边界，不等同于模型开发商。SiliconFlow 可以提供 DeepSeek、Qwen 和 GLM；Copilot Relay 可以提供 GPT、Gemini 和 Grok，但它们在本设计中仍分别是一个逻辑上游服务。

## 4. 目标

### 4.1 功能目标

1. Runtime 只注册一个 Built-in Provider，稳定 ID 为 `builtin`，显示名称固定为 `Built-in LLM`。
2. Built-in 同时只连接一个上游服务。
3. Built-in 支持多个标准 Protocol Client。
4. Protocol Client 根据人工模型注册按需创建。
5. 用户必须为每个模型提供 Model ID 和 Protocol。
6. 用户可以为模型提供可选显示名称。
7. 模型列表不依赖远端 `/models` 接口。
8. AgentRunner 不感知具体 Protocol Client。
9. Extension Provider 继续与 Built-in Provider 并列注册。

### 4.2 首期支持的 Protocol

```text
anthropic-messages
openai-responses
openai-chat-completions
```

### 4.3 非目标

首期不实现：

- 同时连接多个 Built-in 上游服务；
- 同一 Protocol 配置多个 Endpoint；
- 每个 Protocol 使用不同 API Key；
- 动态模型发现；
- 自动同步模型能力；
- Protocol 自动协商；
- Protocol fallback；
- Provider fallback；
- API Key rotation；
- OAuth、IAM、ADC、Entra ID 等特殊身份；
- WebSocket Responses；
- 旧式文本 `/v1/completions`；
- 完整模型成本核算。

这些能力由 Extension Provider 承担，或在出现明确需求后另行设计。

## 5. 配置结构

### 5.1 TypeScript 类型

```ts
export type BuiltinProtocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat-completions";

export interface BuiltinModelRegistration {
  /**
   * 发送给上游服务的真实 Model ID。
   */
  readonly modelId: string;

  /**
   * 调用该模型时使用的唯一 Protocol。
   */
  readonly protocol: BuiltinProtocol;

  /**
   * 可选显示名称；不参与上游请求。
   */
  readonly displayName?: string;
}

export interface BuiltinLlmProviderConfig {
  /**
   * 包含 API 版本前缀，但不包含具体操作路径。
   */
  readonly baseURL: string;

  /**
   * 可选 API Key。
   */
  readonly apiKey?: string;

  /**
   * 人工注册的唯一可执行模型目录。
   */
  readonly models: readonly BuiltinModelRegistration[];
}

export interface LLMConfig {
  /**
   * Runtime 默认使用的 Provider 和 Model；未配置时由请求显式选择。
   */
  readonly defaultModel?: ModelReference;

  /**
   * Runtime 唯一的 Built-in Provider；未配置时不注册 Built-in。
   */
  readonly builtin?: BuiltinLlmProviderConfig;
}

export interface ApplicationConfigProjection {
  /**
   * 应用级 LLM 模块配置。
   */
  readonly llm: LLMConfig;

  readonly agents: AgentsConfig;
  readonly logger: LoggerModuleConfig;
}
```

本设计只调整 LLM 相关配置。`agents`、`logger`、`extensions` 和其他模块的现有结构暂不调整。

`BuiltinProtocol`、`BuiltinModelRegistration`、`BuiltinLlmProviderConfig`、对应语义校验以及 `DEFAULT_BUILTIN_CONTEXT_LIMIT`、`DEFAULT_ANTHROPIC_MAX_TOKENS` 等运行默认值由 `src/builtins/providers/builtin/` 自己拥有。`src/platform/config/` 只导入该叶子 Contract，负责顶层文档组合、读取、凭据物化和冻结，不在 `platform/config/defaults.ts` 中复制 Built-in 默认值。Builtin 模块不得反向导入 Platform Configuration。

现有 Runner、Memory、Prompt、Tool、Context、Compaction 和 Subagent 配置的所有权迁移不属于本次范围，应在独立 Change 中处理，避免把 Built-in Provider 交付扩大为全仓配置重构。

### 5.2 最小配置示例

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "gpt-5.4"
    },
    "builtin": {
      "baseURL": "http://127.0.0.1:5000/v1",
      "models": [
        {
          "modelId": "gpt-5.4",
          "protocol": "openai-responses",
          "displayName": "GPT-5.4"
        },
        {
          "modelId": "gemini-3.8-flash",
          "protocol": "openai-chat-completions"
        }
      ]
    }
  }
}
```

`displayName` 未提供时，Provider Catalog 保持该字段为空。CLI、Web 或其他客户端自行决定是否回退显示 Model ID：

```ts
const label = model.displayName ?? model.modelId;
```

### 5.3 多协议上游示例

同一供应商支持三种协议时，不重复配置连接信息：

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "gpt-model"
    },
    "builtin": {
      "baseURL": "https://llm.example.com/v1",
      "models": [
        {
          "modelId": "claude-model",
          "protocol": "anthropic-messages"
        },
        {
          "modelId": "gpt-model",
          "protocol": "openai-responses"
        },
        {
          "modelId": "gemini-model",
          "protocol": "openai-chat-completions"
        }
      ]
    }
  }
}
```

配置作用域：

- `llm.builtin` 配置 Runtime 创建的唯一 Built-in Provider；未配置时不注册 Built-in；
- `llm.defaultModel` 从 Built-in 或 Extension Provider 中选择默认模型；未配置时 Catalog 保持 `unset`。

`llm.defaultModel` 同时承担两项职责：

1. 下发到 Model Catalog，作为 Client 的初始模型选择；
2. 当请求没有显式 `modelReference` 时，作为 Server 的执行 fallback。

首次启动继续允许生成空配置 `{}` 并正常启动 Runtime、CLI 和 UI。用户可以仅使用 Extension Provider，也可以稍后补充 Built-in 配置。未配置默认模型时 Catalog 状态为 `unset`；配置的 Provider 或 Model 当前不可用时 Catalog 状态为 `unavailable`。两种情况都不阻止启动。

请求执行时优先使用显式 `modelReference`，否则使用 `llm.defaultModel`。两者都不存在时返回可恢复的 `MODEL_MISSING`；fallback 指向未注册 Provider 或被拒绝 Model 时，返回对应的可恢复运行错误。显式选择其他有效模型不受无效默认模型影响。

命名固定为：

| 场景 | 名称 |
|---|---|
| 配置字段 | `llm.builtin` |
| Provider ID | `builtin` |
| Provider 显示名称 | `Built-in LLM` |
| 配置类型 | `BuiltinLlmProviderConfig` |
| 实现类 | `BuiltinLlmProvider` |
| Runtime Unit ID | `builtin-llm-provider` |

配置字段不使用 `builtinProvider`。它已经位于 `llm` 模块中，`builtin` 足以表达稳定 Provider 身份；`Provider` 后缀只保留在代码类型、实现类和 Runtime Unit 名称中。

Runtime 从 `models[].protocol` 推导需要创建的 Client：

```text
anthropic-messages         → AnthropicMessagesClient
openai-responses           → OpenAIResponsesClient
openai-chat-completions    → OpenAIChatCompletionsClient
```

不再单独配置 `protocols` 或 `defaultProtocol`。

### 5.4 API Key

API Key 是可选凭据。部分本地服务、可信网络内的网关和测试端点不要求认证，因此缺少 API Key 不属于配置错误。

`llm.builtin.apiKey` 是可选字符串，与 Copilot Relay Provider 的 `apiKey` 配置保持一致：

```json5
{
  "llm": {
    "builtin": {
      "apiKey": "sk-example"
    }
  }
}
```

也可以用 `${ENV_VAR}` 引用环境变量：

```json5
{
  "llm": {
    "builtin": {
      "apiKey": "${SILICONFLOW_API_KEY}"
    }
  }
}
```

`${ENV_VAR}` 是明确凭据字段的跨平台字符串解析约定，不依赖 Bash、PowerShell 或其他 Shell 展开。环境变量名必须匹配 `[A-Z_][A-Z0-9_]*`。只有整个 `apiKey` 字符串精确匹配该形式时才解析，不支持 `"prefix-${ENV_VAR}"` 等字符串内插值，也不对 Prompt、命令模板或其他普通配置字符串执行全局替换。

共享的凭据字符串解析函数在严格配置校验前完成解析，由 Built-in 配置加载和 Copilot Relay Extension 配置物化共同调用。环境变量不存在或值为空时配置失败，不得把占位字符串原样传给上游，也不得静默降级为无认证请求。错误和日志可以记录环境变量名，但不得记录解析后的值。

Provider 只接收最终字符串，不区分该值由用户直接填写还是由环境变量解析得到。Builtin Provider 和 Copilot Relay Provider 共用该解析函数，不各自实现环境变量解析，也不为 Built-in 定义专用的 SecretRef 类型或隐式环境变量覆盖规则。Extension Acquisition 现有的 `$env` / `$secret` 对象语法继续兼容，本变更不对已有 Extension 配置做破坏性迁移。

对 API Key 执行 `trim()`；未提供或只包含空白字符时统一视为未配置。Provider 仍正常启动，Protocol Client 发起请求时不添加认证 Header。

物化后的 `apiKey` 是 Protocol Client 唯一允许使用的凭据来源。Client
必须显式禁用 SDK 或库对 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等环境变量
的隐式读取；字段缺失时不得从 ambient environment 继承凭据，也不得发送
伪造占位 Key。

配置了 API Key 时，各 Client 根据自身协议生成 Header：

```text
anthropic-messages         → x-api-key: <apiKey>
openai-responses           → Authorization: Bearer <apiKey>
openai-chat-completions    → Authorization: Bearer <apiKey>
```

Builtin 只共享 API Key 值，不统一生成认证 Header。若上游要求其他认证 Header、签名或动态凭据，应实现为 Extension Provider。

Anthropic Messages 还发送标准 `anthropic-version: 2023-06-01` Header。
三种 Client 均发送各自 Wire Protocol 所要求的 JSON Content Header。

API Key 不应出现在默认文档示例、日志或错误详情中。

### 5.5 Base URL

`baseURL` 表示截止到具体操作路径之前的完整 API 前缀：

```text
https://api.openai.com/v1
https://api.anthropic.com/v1
https://api.siliconflow.cn/v1
https://gateway.example.com/tenant/a/api/v1
http://127.0.0.1:5000/v1
```

不强制 `baseURL` 字面上以 `/v1` 结尾，不自动添加、删除或猜测版本路径。这样可以支持 `/api/v1`、租户前缀和其他兼容网关路径。配置加载时统一移除末尾 `/`，并拒绝包含用户名、密码、Query 或 Fragment 的 URL。

Protocol Client 追加标准路径：

```text
anthropic-messages         → /messages
openai-responses           → /responses
openai-chat-completions    → /chat/completions
```

如果供应商不共享 Base URL、具体操作路径不符合上述标准路径，或要求不同协议使用不同凭据，应实现为 Extension Provider。Copilot Relay Extension 现有的服务根地址语义继续保持兼容，不因 Built-in 的 API 前缀定义而迁移。

## 6. 模型注册

### 6.1 唯一权威来源

`llm.builtin.models` 是 Built-in Provider 唯一的模型目录。Runtime 不调用以下接口构建 Catalog：

```text
/v1/models
models.list
/api/tags
/api/show
```

远端模型列表可以用于人工研究、生成配置草稿或离线测试，但不参与正常启动和运行时解析。

### 6.2 最小字段

每个模型只要求：

```text
modelId
protocol
displayName?
```

不要求用户配置：

```text
effectiveContextLimit
maximumOutputTokens
toolUse
mediaKinds
pricing
reasoning
structuredOutput
```

这些字段在不同供应商之间缺乏统一、可靠的数据来源，不应成为基本配置负担。

### 6.3 Protocol 绑定

每个模型只绑定一个 Protocol。即使上游允许同一模型使用多个 Protocol，当前配置仍由用户明确选择其中一个：

```json
{
  "modelId": "gpt-5.4",
  "protocol": "openai-responses"
}
```

若要切换为 Chat Completions，修改配置并重新加载 Provider：

```json
{
  "modelId": "gpt-5.4",
  "protocol": "openai-chat-completions"
}
```

首期不进行运行时 Protocol 选择或失败切换。

### 6.4 未知能力处理

模型未显式配置能力不表示“不支持”。Builtin 使用以下策略：

- Context window 使用代码维护的保守默认值 `32,768`；
- 不预判模型真实最大输出；
- OpenAI Responses 和 OpenAI Chat Completions 默认不发送输出 Token 上限；
- Anthropic Messages 因协议要求必须提供 `max_tokens`，由 Client 内部使用固定 fallback `4,096`；
- Anthropic fallback 只是协议适配参数，不写入模型 `maximumOutputTokens` Facts；
- `toolUse === undefined` 表示未知，允许 Protocol Client 正常编码并发送；
- `toolUse === false` 表示明确不支持，Runtime 在调用前拒绝；
- `mediaKinds === undefined` 表示未知，允许对应 Protocol Client 编码并发送；
- `mediaKinds` 明确存在但不包含请求类型时，Runtime 在调用前拒绝；
- 上游拒绝未知或不支持的能力时，转换为明确 Provider 错误。

Tool 和 Media 都采用三态语义：

```text
undefined       → 能力未知，fail-open，允许尝试
false / []      → 明确不支持，拒绝请求
true / ["image"] → 明确支持，允许请求
```

已知能力随 Model Catalog 下发给 Client。Client 可以据此禁用附件入口或提前提示，但不得把客户端检查作为唯一保障；服务端仍执行最终校验。能力未知时 Client 保持附件入口可用。

附件处理采用整条消息原子语义：

- 任一附件 MIME 不支持、内容与 MIME 不匹配、无法解析、压缩失败、压缩后仍超限，或导致数量/总大小超限时，整条消息失败；
- 多附件消息中任一附件失败时，其余附件和文本也不发送，用户修正后重新提交；
- 模型明确不支持请求中的 Media 类型时，整条消息在调用 Provider 前失败；
- 模型能力未知时允许尝试发送；若上游拒绝，则本次调用失败；
- 任何失败路径都不得删除附件后自动重试纯文本请求。

这取代现有附件管线“丢弃失败附件并添加文本提示后继续”的行为，确保用户提交的文本和附件作为一个不可分割的请求处理。

`32,768` 是 Runtime 用于历史裁剪的保守运行边界，不表示模型的真实 Context 硬上限。Provider 在内部按部署配置、Provider Metadata、静态目录和代码 fallback 的顺序选择最终值，但不再为每个值附加来源标签。已知模型能力以后可以由内部版本化目录或高级配置补充并覆盖默认值，但不属于首期用户配置。

用户期望的回答篇幅由 Prompt 控制。首期删除旧配置字段 `llm.maxTokens`，不引入 `llm.maxOutputTokens` 替代它；同时从公共调用链删除 `ModelRequestOverride.maxOutputTokens`、`ModelPolicy.defaultMaxTokens`、`ModelPolicy.maximumMaxTokens`、`ResolvedModel.limits.maxTokens`、`ModelInvocationRequest.maxTokens` 以及 Channel/WebSocket 的对应请求字段。OpenAI Clients 不发送输出 Token 上限；Anthropic Messages Client 固定发送 `max_tokens: 4,096`。

可信 Catalog 或 Provider Metadata 中的 `maximumOutputTokens` 可以继续作为信息性模型事实保留，但 `ModelResolver` 不要求它存在，也不再用它限制请求。首期不提供全局或单次请求输出 Token 配置，避免把请求预算、模型真实上限和协议必填 fallback 混为一谈。如果以后重新开放硬性请求预算，应使用能明确表达请求级语义的新名称。

## 7. 代码目录

建议将现有 Anthropic Built-in 重组为统一 Provider：

```text
src/builtins/providers/
└─ builtin/
   ├─ BuiltinLlmProvider.ts
   ├─ BuiltinLlmProvider.test.ts
   ├─ model-config.ts
   ├─ model-config.test.ts
   ├─ protocol-client-registry.ts
   ├─ protocol-client-registry.test.ts
   ├─ runtime-unit.ts
   ├─ runtime-unit.test.ts
   ├─ index.ts
   │
   ├─ clients/
   │  ├─ AnthropicMessagesClient.ts
   │  ├─ AnthropicMessagesClient.test.ts
   │  ├─ OpenAIResponsesClient.ts
   │  ├─ OpenAIResponsesClient.test.ts
   │  ├─ OpenAIChatCompletionsClient.ts
   │  └─ OpenAIChatCompletionsClient.test.ts
   │
   └─ codecs/
      ├─ anthropic-message-codec.ts
      ├─ anthropic-tool-codec.ts
      ├─ openai-responses-codec.ts
      ├─ openai-chat-completions-codec.ts
      └─ openai-tool-codec.ts
```

测试文件保持与源码相邻，符合当前项目模式。

## 8. Protocol Client Registry

```ts
export interface ProtocolClientOptions {
  readonly baseURL: string;
  readonly apiKey?: string;
}

export type ProtocolClientFactory = (
  options: ProtocolClientOptions,
) => ModelInvocationPort;

export const BUILTIN_PROTOCOL_CLIENT_FACTORIES = Object.freeze({
  "anthropic-messages": createAnthropicMessagesClient,
  "openai-responses": createOpenAIResponsesClient,
  "openai-chat-completions": createOpenAIChatCompletionsClient,
} satisfies Record<BuiltinProtocol, ProtocolClientFactory>);
```

只为人工注册模型实际引用的 Protocol 创建 Client：

```ts
const requiredProtocols = new Set(
  config.models.map((model) => model.protocol),
);

for (const protocol of requiredProtocols) {
  clients.set(
    protocol,
    BUILTIN_PROTOCOL_CLIENT_FACTORIES[protocol]({
      baseURL: config.baseURL,
      ...(resolvedApiKey === undefined
        ? {}
        : { apiKey: resolvedApiKey }),
    }),
  );
}
```

每个 Client 只在 `apiKey` 存在时添加本协议的认证 Header。不得发送空的 `Authorization`、空的 `x-api-key` 或伪造占位凭据。

增加新 Protocol 时，主要改动为：

1. 新增 Protocol Client；
2. 新增 Codec；
3. 注册 Client Factory；
4. 扩展 `BuiltinProtocol`；
5. 增加合同测试。

不需要新增 Built-in Provider。

## 9. BuiltinLlmProvider

```ts
export const BUILTIN_LLM_PROVIDER_ID = "builtin";
export const BUILTIN_LLM_PROVIDER_DISPLAY_NAME = "Built-in LLM";
export const BUILTIN_ROUTING_PROTOCOL = "builtin-model-router";

export class BuiltinLlmProvider {
  readonly entry: ProviderProjectionEntry;

  constructor(config: BuiltinLlmProviderConfig) {
    const models = validateAndCaptureModels(config.models);
    const clients = createRequiredProtocolClients(config, models);
    const invocationPort = createModelRoutingInvocationPort(models, clients);
    const endpointId = normalizeEndpoint(config.baseURL);

    this.entry = Object.freeze({
      id: BUILTIN_LLM_PROVIDER_ID,
      displayName: BUILTIN_LLM_PROVIDER_DISPLAY_NAME,
      protocol: BUILTIN_ROUTING_PROTOCOL,
      invocationPort,
      models: Object.freeze(
        models.map((model) =>
          Object.freeze({
            modelId: model.modelId,
            ...(model.displayName
              ? { displayName: model.displayName }
              : {}),
          }),
        ),
      ),
      resolveConnection: () =>
        Object.freeze({
          ok: true,
          connection: Object.freeze({ endpointId }),
        }),
      resolveModel: (modelId, connection) => {
        const model = models.find((entry) => entry.modelId === modelId);
        if (!model) {
          return {
            ok: false,
            category: "model_rejected",
            message: "Model is not registered in the Built-in Provider.",
          };
        }

        return {
          ok: true,
          descriptor: Object.freeze({
            identity: Object.freeze({
              providerId: BUILTIN_LLM_PROVIDER_ID,
              modelId: model.modelId,
            }),
            connection,
            facts: createDefaultModelFacts(),
            protocol: BUILTIN_ROUTING_PROTOCOL,
          }),
        };
      },
    });
  }
}
```

示例仅表达职责分配，最终实现应复用项目现有的错误、冻结和校验模式。

`createModelRoutingInvocationPort()` 实现现有 `ModelInvocationPort`。它根据 `request.model` 查找人工模型注册项，再使用该模型的 `protocol` 从 Client Registry 选择对应 Client。模型不存在或 Protocol Client 缺失时显式失败，不进行协议猜测或 fallback。

## 10. 核心 Contract 保持不变

外部调用和公共 Provider Contract 均保持现状：

```ts
interface ProviderProjectionEntry {
  id: string;
  models: readonly ProviderCatalogModel[];
  protocol: string;
  invocationPort: ModelInvocationPort;
  resolveConnection(): ProviderConnectionResult;
  resolveModel(
    modelId: string,
    connection: ProviderConnection,
  ): ProviderModelResult;
}
```

调用方继续只提供 `providerId` 和 `modelId`。`ModelResolver`、`ResolvedModel`、AgentRunner、Extension API 和 Copilot Relay Provider 不需要因 Built-in 的多协议实现而迁移。

`BUILTIN_ROUTING_PROTOCOL` 表示 Built-in Provider 的内部调度边界，不冒充具体上游协议。实际 `anthropic-messages`、`openai-responses` 或 `openai-chat-completions` 只存在于 Built-in 的模型注册和内部诊断中。

Model Catalog 增加可选能力投影，这是向后兼容的增量字段：

```ts
interface ModelCatalogEntry {
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities?: {
    readonly toolUse?: boolean;
    readonly mediaKinds?: readonly string[];
  };
}
```

只有已知能力才进入 Catalog。`capabilities` 或其中字段缺失表示未知，不得序列化为 `false` 或空集合。HTML Client 对所选模型应用：

- `mediaKinds === undefined`：能力未知，附件入口保持可用；
- `mediaKinds` 包含 `"image"`：附件入口可用；
- `mediaKinds` 明确存在但不包含 `"image"`：禁用附件按钮并提示“当前模型不支持图片”。

Client 检查仅用于 UX；服务端仍是能力校验的权威边界。

## 11. Runtime Unit

```ts
export const BUILTIN_LLM_PROVIDER_UNIT_ID =
  "builtin-llm-provider";

export function createBuiltinLlmProviderUnit(
  options: BuiltinLlmProviderConfig,
): LoadedRuntimeUnit {
  const capturedOptions = captureOptions(options);

  return Object.freeze({
    unitId: BUILTIN_LLM_PROVIDER_UNIT_ID,
    source: "builtin",
    orderKey: BUILTIN_LLM_PROVIDER_UNIT_ID,
    required: true,
    initiallyEnabled: true,
    dependencies: Object.freeze([]),
    create() {
      const provider = new BuiltinLlmProvider(capturedOptions);
      return Object.freeze({
        registration: Object.freeze({
          id: BUILTIN_LLM_PROVIDER_UNIT_ID,
          source: "builtin",
          register(api: ExtensionRegistrationApi) {
            api.registerProvider(provider.entry);
          },
        }),
        start() {},
        stop() {},
      });
    },
  });
}
```

## 12. 配置校验

启动时必须校验：

### Provider

- `llm.defaultModel` 如果存在则必须是结构合法的 `ModelReference`；Provider 或 Model 的运行时可用性投影为 Catalog 的 `available` / `unavailable` 状态，不阻止启动；
- `llm.builtin` 如果存在则只能配置一个 Built-in Provider；
- `llm.builtin` 存在时，`baseURL` 是合法 HTTP/HTTPS URL；
- `llm.builtin` 存在时，URL 不包含用户名或密码；
- `llm.builtin.models` 必须是数组，可以为空；为空时注册空 Catalog，不创建 Protocol Client，也不发起网络请求；
- `apiKey` 如果存在则必须为字符串；
- `apiKey` 精确匹配 `${ENV_VAR}` 时，变量名必须匹配 `[A-Z_][A-Z0-9_]*`；
- `apiKey` 引用的环境变量不存在或值为空时配置失败；
- 未提供或只包含空白字符的 API Key 视为未配置。

### Model

- `modelId` 是非空字符串；
- `modelId` 在同一配置中不重复；
- `protocol` 是已注册的 Built-in Protocol；
- `displayName` 如果存在则为非空字符串。

模型能力字段不属于首期用户配置，因此不在此处校验。

## 13. 错误处理

Protocol Client 继续使用现有版本化错误 ABI：

```ts
type ModelInvocationFailureCategory =
  | "authentication"
  | "rate_limit"
  | "invalid_request"
  | "unavailable"
  | "transport"
  | "provider_failure";
```

错误结构保持：

```ts
interface ModelInvocationStructuralErrorV1 extends Error {
  readonly protocol: "my-agent.model-invocation-error";
  readonly version: 1;
  readonly category: ModelInvocationFailureCategory;
  readonly diagnostics?: ModelInvocationDiagnostics;
}
```

映射规则：

| 上游错误 | Category |
|---|---|
| 401/403 | `authentication` |
| 429，包括供应商以限流形式报告的额度错误 | `rate_limit` |
| 其他 4xx、内容过滤、能力或参数被拒绝 | `invalid_request` |
| 模型或服务暂不可用 | `unavailable` |
| DNS、连接、超时、流中断 | `transport` |
| 其他上游 5xx 或无法进一步分类的失败 | `provider_failure` |

Context overflow 继续使用现有 `ContextOverflowError`，保留 Provider 返回或推断的 Context 修正信息。HTTP 状态、Provider error type/code/message 和 request ID 继续放在 `diagnostics` 中。首期不增加 `retryable`、`retryAfterMs` 或平行的错误结构；重试策略由 Runtime 根据规范化类别决定，而不是由各 Client 自行声明。

现有 v1 diagnostics 中的 `request.maxTokens` 放宽为可选字段。这是向后兼容的结构扩展：旧 Provider 继续提供时仍可被接受；OpenAI Clients 省略；Anthropic Messages Client 记录实际发送的 `4,096`。错误 envelope、`protocol`、`version` 和 `category` 保持不变。

错误不得转换为普通文本、空响应或其他成功形状。

## 14. 重试策略

每次 Protocol Client invocation 只执行一次上游 HTTP 尝试。SDK 或传输库
内建的 429、5xx、DNS 和连接失败自动重试必须关闭，使三个 Protocol 的
可观察行为一致。失败按现有 Model Invocation Error V1 分类后交回 Runtime；
Client 不自行重放整个 Turn。

现有 Runner-owned Context compaction retry 保持不变。Builtin 不执行
Protocol 或 Provider fallback，也不通过删除 Tool、Media 或修改内容后重试。

## 15. Extension 边界

以下需求由 Extension Provider 实现：

- 同时连接多个供应商；
- 同一 Protocol 配置多个 Endpoint；
- 不同 Protocol 使用不同 Base URL；
- 不同 Protocol 使用不同 API Key；
- 多 API Key rotation；
- OAuth、AWS IAM、Google ADC、Azure Entra ID；
- 自动模型发现和能力同步；
- Provider fallback；
- 供应商专有协议；
- 自定义签名和动态凭据刷新。

Extension Provider 继续通过现有 Extension API 注册独立 `ProviderProjectionEntry`。

## 16. 测试

### 16.1 配置测试

- 仅注册一个模型；
- 注册多个不同 Protocol 的模型；
- 空配置正常启动且不注册 Built-in Provider；
- 未配置 `llm.defaultModel` 时 Catalog 默认选择状态为 `unset`；
- 没有默认模型且请求未显式选择模型时返回明确错误；
- 默认模型可用时 Client 初始选择该模型，请求未显式指定时 Server 使用它作为 fallback；
- 默认 Provider 或 Model 不可用时 Catalog 状态为 `unavailable`，但 Runtime 继续启动；
- 无效默认模型不影响请求显式选择其他有效模型；
- 请求依赖无效默认模型时返回对应的可恢复运行错误；
- 仅使用 Extension Provider 时不要求配置 `llm.builtin`；
- 配置 `llm.builtin` 后缺少 `baseURL` 或有效模型时失败；
- `displayName` 缺失；
- 重复 Model ID；
- 空 Model ID；
- 未知 Protocol；
- 空 Models 正常注册空 Catalog且不创建 Client；
- 非法 Base URL；
- Base URL 保留 `/api/v1`、租户路径等完整 API 前缀；
- Base URL 不强制以 `/v1` 结尾；
- Base URL 末尾 `/` 被规范化且不改变前缀路径；
- Base URL 包含用户名、密码、Query 或 Fragment 时失败；
- 未配置 API Key 时正常创建 Provider；
- 空白 API Key 视为未配置；
- 未配置 API Key 时不发送认证 Header；
- 字符串 API Key 正常解析；
- `${ENV_VAR}` API Key 正常解析；
- `${ENV_VAR}` 在 Windows、Linux 和 macOS 上使用相同配置语法；
- 环境变量不存在或值为空时配置失败；
- 不解析 `"prefix-${ENV_VAR}"` 等内嵌占位符；
- Prompt、命令模板和非凭据字段中的 `${ENV_VAR}` 保持原值；
- Built-in 和 Copilot Relay 使用同一配置加载规则；
- Copilot Relay 现有 `$env` / `$secret` 配置继续有效；
- 不同 Protocol 使用各自的认证 Header；
- 拒绝旧的 `agents.defaults.model` 和 Agent 级 LLM 配置；
- 拒绝旧的 Agent 级 `llm.apiKey`、`llm.baseURL` 和 `llm.deploymentFacts`。

### 16.2 Provider 测试

- Provider ID 固定为 `builtin`；
- Catalog 只包含人工注册模型；
- Catalog 保持配置顺序；
- 不调用远端模型列表；
- 只创建模型实际引用的 Protocol Client；
- Model ID 原样传给上游；
- `displayName` 不参与请求；
- 未注册模型返回 `model_rejected`；
- 模型绑定到正确的 Protocol Client；
- 未知模型使用 `32,768` 的 Context 运行边界；
- `ProviderModelFacts` 使用普通可选值，不包含 `ModelFactSource` 或 `SourcedFact<T>`；
- 未知模型不生成虚假的 `maximumOutputTokens` Fact；
- OpenAI Clients 在未指定请求级预算时不发送输出 Token 上限；
- Anthropic Messages Client 固定发送内部 fallback `4,096`；
- Anthropic fallback 不进入模型 Facts 或用户配置；
- 公共 Contract、Channel 和 WebSocket 中不再存在输出 Token override 或默认值；
- v1 diagnostics 接受缺失的 `request.maxTokens`，也继续接受旧 Provider 提供的正整数；
- Tool 能力未知时允许发送，明确为 `false` 时拒绝；
- Media 能力未知时允许发送，明确不包含请求类型时拒绝；
- 已知 Tool 和 Media 能力进入 Model Catalog；
- 未知能力在 Catalog 和 wire payload 中保持缺失；
- 所选模型明确不支持图片时 HTML Client 禁用附件入口并提示；
- 所选模型图片能力未知时 HTML Client 保持附件入口可用；
- 模型能力错误不触发移除 Tool 或附件后的静默重试；
- 任一附件格式、内容、压缩、单文件大小、数量或总大小校验失败时整条消息失败；
- 多附件消息中任一附件失败时不发送其他附件或文本；
- 附件失败时不调用 Model Provider；
- 配置和 Catalog 对象被冻结。

### 16.3 Client 合同测试

每个 Client 覆盖：

- 文本请求和文本流；
- System prompt；
- 多轮消息；
- Tool definition、Tool call 和 Tool result；
- 多个 Tool call；
- 图片输入；
- Usage；
- Stop reason；
- `AbortSignal`；
- Malformed stream；
- 流缺少终止事件；
- 认证失败；
- 429 和 5xx；
- Context overflow。
- 三种 Client 使用相同的现有版本化错误 ABI 和 6 类映射；
- Copilot Relay 错误合同保持兼容。

### 16.4 外部兼容性测试

Copilot Relay、SiliconFlow 或其他服务只作为外部测试端点：

- 不构成产品运行时依赖；
- 不进入 Provider 公共命名；
- 不在 Runtime Composition 中导入其实现；
- 不依赖它们的模型列表；
- 测试模型由 Fixture 或测试配置人工注册。

### 16.5 架构适应性测试

- Core 不导入具体 SDK；
- AgentRunner 不导入 Protocol Client；
- Built-in Provider 只通过 `ModelInvocationPort` 暴露调用；
- Protocol Client 相互不依赖；
- Extension API 不暴露具体 SDK 类型；
- 删除任一 Protocol Client 不要求修改 AgentRunner。

## 17. 实施阶段

### 阶段一：核心 Contract 与配置

- 新增可选的顶层 `llm.defaultModel` 和 `llm.builtin`；
- 保持空配置首次启动能力，未配置 Built-in 时不注册该 Runtime Unit；
- 从 `agents.defaults` 和 `agents.list[]` 中移除 LLM 相关配置；
- 删除旧的 Agent 级 `llm.apiKey`、`llm.baseURL` 和 `llm.deploymentFacts`；
- 新增仅供明确凭据字段使用的 `${ENV_VAR}` 共享解析函数，并接入 Built-in 与 Copilot Relay；
- 删除公共输出 Token 配置、Policy、请求 override、ResolvedModel limit 和 Invocation Request 字段；
- 放宽 v1 diagnostics 的 `request.maxTokens` 为可选，并允许模型 `maximumOutputTokens` Fact 缺失；
- 增加人工 Models 配置；
- 更新 ModelResolver 和 Registry 校验。

### 阶段二：统一 Built-in Provider

- 新增 `BuiltinLlmProvider`；
- 将现有 Anthropic Client 移入统一目录；
- 新增 Protocol Client Registry；
- 新增按 Model ID 选择 Protocol Client 的内部 `ModelInvocationPort`；
- 新增统一 Runtime Unit；
- Provider ID 固定为 `builtin`。

### 阶段三：OpenAI Protocol Clients

- 新增 `OpenAIResponsesClient`；
- 新增 `OpenAIChatCompletionsClient`；
- 为三种 Client 建立统一合同测试；
- 接入 Copilot Relay 等外部测试端点。

### 阶段四：收尾

- 更新配置文档和 Provider 文档；
- 将附件 intake 从“丢弃失败附件并继续”改为“任一附件失败则整条消息失败”；
- 删除旧 Anthropic Provider 装配；
- 更新 Architecture Fitness；
- 运行 Unit、Integration、Fitness 和 Build；
- 仅在边界稳定后提取共享 Codec。

## 18. 结论

本设计不再按供应商品牌或兼容协议拆分 Built-in Provider。

三个 Protocol Client 均为项目自有的最小 HTTP/SSE Adapter，只实现
`ModelInvocationPort` 所需的消息、Tool、Media、Streaming、Usage、Stop、
Abort 和错误归一化能力。它们不是通用 Anthropic/OpenAI SDK，不实现 Agent
未使用的 Files、Batches、Embeddings、Audio、Assistants、管理 API、分页
Helper 或其他供应商完整功能。新增协议行为必须来自已接受的 Agent 用例和
合同测试，不为追求 SDK parity 预先扩展。

```text
一个 BuiltinLlmProvider
一个上游服务连接
多个按需创建的 Protocol Client
用户人工注册 Models
每个 Model 绑定一个 Protocol
```

用户模型配置最小化为：

```ts
interface BuiltinModelRegistration {
  modelId: string;
  protocol: BuiltinProtocol;
  displayName?: string;
}
```

复杂供应商集成、多连接、特殊认证、动态模型发现和故障切换全部由 Extension Provider 承担。
