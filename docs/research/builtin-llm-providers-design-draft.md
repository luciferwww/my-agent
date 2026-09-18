# Built-in LLM Providers 设计草稿

> 状态：非权威研究草稿  
> 日期：2026-09-18  
> 范围：为 my-agent 增加支持多种 Wire Protocol 的 OpenAI-compatible Built-in Provider，并调整现有 LLM 配置结构  
> 约束：本文不授权实现；若进入开发，应先按项目工作流创建对应的 Active Change

## 1. 背景

my-agent 当前只有一个 Built-in LLM Provider：

```text
anthropic-compatible
└─ Anthropic Messages API
```

项目已经具备 Provider Registry、ModelResolver 和统一的 `ModelInvocationPort`，因此不再增加统一的聚合 Provider。目标结构为：

```text
Built-in Providers
├─ anthropic-compatible
│  └─ AnthropicMessagesClient
└─ openai-compatible
   ├─ OpenAIResponsesClient
   └─ OpenAIChatCompletionsClient
```

两个 Provider 独立注册、独立配置，并共同实现核心模型调用合同。

## 2. 目标

### 2.1 功能目标

1. 保留现有 `anthropic-compatible` Provider。
2. 新增 `openai-compatible` Provider。
3. 两个 Provider 可以同时配置和注册。
4. 默认模型继续通过 `providerId + modelId` 选择。
5. 两个 Provider 都允许覆盖 `baseURL`：
   - 默认连接官方 API；
   - 自定义 URL 连接对应协议的兼容服务。
6. API Key 支持环境变量和配置文件。
7. AgentRunner 不感知 Anthropic/OpenAI 差异。
8. Built-in Provider 与 Extension Provider 继续使用同一 Registry。
9. OpenAI Provider 可以通过新增 Client 扩展 Wire Protocol，而不为每种协议创建新的 Provider。

### 2.2 非目标

第一阶段不实现：

- 聚合 `BuiltinLlmProvider`；
- Provider 内部的 Adapter 二次路由；
- 第一阶段交付 OpenAI Chat Completions API；
- Gemini Provider；
- 一个 Provider 多 Connection；
- 多 API Key rotation；
- 自动跨模型或跨 Provider fallback；
- 动态安装 Provider；
- 通用 Provider 插件协议重构；
- 完整成本核算；
- OpenAI Organization/Project 配置。

## 3. 核心设计

### 3.1 Provider 划分

#### Anthropic

```text
Provider ID: anthropic-compatible
Protocol: anthropic-messages
Client: AnthropicMessagesClient
Default endpoint: Anthropic 官方 API
Custom endpoint: Anthropic Messages-compatible API
```

#### OpenAI

```text
Provider ID: openai-compatible
Protocols:
  - openai-responses
  - openai-chat-completions
Clients:
  - OpenAIResponsesClient
  - OpenAIChatCompletionsClient
Default endpoint: OpenAI 官方 Responses API
Custom endpoint: OpenAI-compatible API
```

OpenAI Provider 表示服务身份、连接和模型目录；Responses 与 Chat Completions 是该 Provider 支持的 Wire Protocol，不分别创建 Provider。第一阶段只交付 Responses Client，但配置和执行绑定应允许后续增加 Chat Completions Client。

### 3.2 Provider 职责

每个 Provider 负责：

- Provider ID 和显示名称；
- Model Catalog；
- 支持的 Protocol 声明和协议选择；
- Connection 验证；
- Model Resolution；
- Model capability facts；
- 创建并持有 Invocation Client。

### 3.3 Client 职责

每个 Client 负责：

- 请求编码；
- HTTP 或 SDK 调用；
- 流式事件解析；
- 文本和 Tool call 转换；
- Usage 和 Stop reason 转换；
- `AbortSignal`；
- Provider 错误转换。

### 3.4 执行绑定

Provider 可以支持多个 Protocol，但一次解析完成的模型调用只能绑定一个明确的 Protocol 和 Client：

```ts
export interface ProviderExecutionBinding {
  readonly protocol: string;
  readonly invocationPort: ModelInvocationPort;
}
```

建议将当前位于 `ProviderProjectionEntry` 上的 `protocol` 和 `invocationPort` 下移到 `ProviderModelDescriptor` 的执行绑定中：

```ts
export interface ProviderModelDescriptor {
  readonly identity: CanonicalModelIdentity;
  readonly connection: ProviderConnection;
  readonly facts: ProviderModelFacts;
  readonly execution: ProviderExecutionBinding;
}
```

`resolveModel()` 负责根据显式配置、模型能力、Endpoint 能力和已注册 Client 选择执行绑定。AgentRunner 只消费解析结果，不再次选择 Protocol。

### 3.5 Runtime Unit 职责

每个 Built-in Provider 拥有独立 Runtime Unit：

```text
createAnthropicProviderUnit()
createOpenAIProviderUnit()
```

Runtime Unit 负责捕获和冻结配置、延迟创建 Provider、注册 `ProviderProjectionEntry` 以及生命周期管理。

## 4. 配置草稿

### 4.1 TypeScript 类型

```ts
export interface LLMConfig {
  /** Agent 默认最大输出 token 策略。 */
  maxTokens: number;

  /** Built-in LLM Provider 配置。 */
  providers?: BuiltinProviderConfigs;
}

export interface BuiltinProviderConfigs {
  "anthropic-compatible"?: AnthropicCompatibleProviderConfig;
  "openai-compatible"?: OpenAICompatibleProviderConfig;
}

export interface AnthropicCompatibleProviderConfig {
  /** 未配置时读取 ANTHROPIC_API_KEY。 */
  apiKey?: string;
  /** 未配置时使用 Anthropic 官方地址。 */
  baseURL?: string;
  deploymentFacts?: LLMDeploymentFactsEntry[];
}

export interface OpenAICompatibleProviderConfig {
  /** 未配置时读取 OPENAI_API_KEY。 */
  apiKey?: string;
  /** 未配置时使用 OpenAI 官方地址。 */
  baseURL?: string;
  /** 当前 Provider 实例使用的 Wire Protocol；默认使用 OpenAI Responses API。 */
  protocol?: "openai-responses" | "openai-chat-completions";
  deploymentFacts?: LLMDeploymentFactsEntry[];
}
```

### 4.2 启用规则

第一版不增加 `enabled`：

```text
Provider 配置块存在 → 创建并注册 Provider
Provider 配置块不存在 → 不注册 Provider
```

这样可以避免“不存在、存在但禁用、存在且启用”三种状态带来的额外复杂度。

### 4.3 配置示例

```json
{
  "agents": {
    "defaults": {
      "model": {
        "providerId": "anthropic-compatible",
        "modelId": "claude-sonnet-4-6"
      },
      "llm": {
        "maxTokens": 8192,
        "providers": {
          "anthropic-compatible": {
            "baseURL": "https://api.anthropic.com"
          },
          "openai-compatible": {
            "baseURL": "https://api.openai.com/v1",
            "protocol": "openai-responses"
          }
        }
      }
    }
  }
}
```

默认环境变量：

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
```

建议优先级：

```text
环境变量 > 配置文件 apiKey > 未配置
```

## 5. 配置切换规则

不保留旧版 LLM 配置兼容层，新结构是唯一合法格式：

```text
llm.apiKey         → 删除
llm.baseURL        → 删除
llm.deploymentFacts → 删除
llm.providers      → Provider 配置的唯一入口
```

配置加载器遇到旧字段时应明确返回配置校验错误，不执行隐式迁移、默认补全或弃用期兼容。

如果 `llm.providers` 不存在或为空：

- 不隐式创建 `anthropic-compatible`；
- Built-in Provider Registry 保持为空；
- Extension Provider 仍可独立注册；
- 默认模型最终无法解析时，沿用模型解析错误路径明确失败。

## 6. 模型选择

继续使用现有的 `ModelReference`：

```ts
interface ModelReference {
  providerId: string;
  modelId: string;
}
```

Anthropic 示例：

```json
{
  "model": {
    "providerId": "anthropic-compatible",
    "modelId": "claude-sonnet-4-6"
  }
}
```

OpenAI 示例：

```json
{
  "model": {
    "providerId": "openai-compatible",
    "modelId": "gpt-5"
  }
}
```

不使用统一的 `builtin` Provider ID，避免在聚合 Provider 内重复实现跨供应方的模型路由。各 Provider 仍可在自身支持的协议集合中选择执行 Client。

## 7. 代码结构草稿

### 7.1 Anthropic

保留现有结构：

```text
src/builtins/providers/anthropic/
├─ AnthropicCompatibleProvider.ts
├─ AnthropicMessagesClient.ts
├─ tool-codec.ts
├─ runtime-unit.ts
├─ index.ts
└─ *.test.ts
```

### 7.2 OpenAI

新增对称结构：

```text
src/builtins/providers/openai/
├─ OpenAICompatibleProvider.ts
├─ client-factory.ts
├─ clients/
│  ├─ OpenAIResponsesClient.ts
│  └─ OpenAIChatCompletionsClient.ts
├─ codecs/
│  ├─ responses-codec.ts
│  ├─ chat-completions-codec.ts
│  └─ tool-codec.ts
├─ model-catalog.ts
├─ runtime-unit.ts
├─ index.ts
└─ *.test.ts
```

### 7.3 运行时装配

```ts
const anthropic = config.llm.providers?.["anthropic-compatible"];
if (anthropic) {
  units.push(createAnthropicProviderUnit(anthropic));
}

const openai = config.llm.providers?.["openai-compatible"];
if (openai) {
  units.push(createOpenAIProviderUnit(openai));
}
```

每个 Unit 独立调用：

```ts
api.registerProvider(provider.entry);
```

最终 Registry：

```text
ProviderProjectionEntry[]
├─ anthropic-compatible
├─ openai-compatible
└─ Extension Providers...
```

## 8. OpenAI Protocol Clients

`OpenAICompatibleProvider` 持有按 Protocol 注册的 Client Factory。Provider 在 `resolveModel()` 阶段选择唯一执行绑定，不在每次 `chat()` 调用时重新猜测协议。

```ts
const OPENAI_CLIENT_FACTORIES = {
  "openai-responses": createOpenAIResponsesClient,
  "openai-chat-completions": createOpenAIChatCompletionsClient,
} satisfies Record<string, OpenAIClientFactory>;
```

第一阶段只启用 `openai-responses`；后续增加 Chat Completions 时，主要新增 Client、Codec、模型协议能力和合同测试，不新增 Provider。

### 8.1 Responses 请求映射

```text
model     → model
system    → instructions 或 system input
messages  → input items
tools     → function tools
maxTokens → max_output_tokens
signal    → fetch AbortSignal
```

### 8.2 Responses 内容映射

```text
ChatContentBlock.text        → input_text / output_text
ChatContentBlock.image       → input_image
ChatContentBlock.tool_use    → function_call
ChatContentBlock.tool_result → function_call_output
```

### 8.3 Responses 流事件映射

```text
response.created           → message_start
response.output_text.delta → text_delta
function_call 完成         → tool_call
response.completed         → message_end
响应或协议错误             → error
```

第一阶段继续使用现有完整 `tool_call` 事件，不立即增加 Tool Arguments Delta。

### 8.4 Chat Completions 后续支持

后续增加 `OpenAIChatCompletionsClient`，覆盖：

- `/v1/chat/completions` 请求编码；
- `choices[].delta.content`；
- 增量 `choices[].delta.tool_calls` 组装；
- `finish_reason` 和 Usage 归一；
- Ollama、LM Studio、vLLM、LiteLLM 等兼容端点的合同测试。

不计划支持旧式文本 `/v1/completions`。

### 8.5 Stop reason 归一

```text
正常完成   → end_turn
存在函数调用 → tool_use
达到输出限制 → max_tokens
```

未知 Stop reason 不应静默映射，应返回明确错误或保留原始原因用于诊断。

## 9. 模型目录与能力事实

### 9.1 事实来源优先级

两个 Provider 统一使用：

```text
deployment-config
  >
provider-metadata
  >
static-provider-catalog
  >
provider-default
```

### 9.2 官方 Endpoint

官方 Endpoint 可以使用对应的内置静态 Catalog：

```text
Anthropic 官方 Endpoint → Anthropic 静态 Catalog
OpenAI 官方 Endpoint    → OpenAI 静态 Catalog
```

### 9.3 自定义 Endpoint

自定义 Endpoint 不应无条件继承官方模型事实：

```text
自定义 Endpoint
├─ 有 deploymentFacts → 使用显式事实
├─ 支持模型发现        → 使用 Provider metadata
└─ 两者都没有          → 不声明无法验证的执行关键能力
```

缺少工具、图片或输出上限事实时，应由 `ModelResolver` 返回 `facts_insufficient`，而不是猜测兼容端点具有官方模型的全部能力。

## 10. 与 Copilot Relay Extension 的关系

现有 Copilot Relay Extension 已实现 OpenAI Responses-compatible 调用。建议：

1. Built-in OpenAI Provider 不依赖 Copilot Relay Extension；
2. OpenAI Built-in 和 Copilot Relay 保留独立 Provider 身份；
3. 两者可以共享稳定的 Responses Codec、SSE Parser 和 Tool Codec；
4. 模型发现、Endpoint、认证和能力事实仍由各自 Provider 管理。

如果第一阶段提取共享代码会显著增加边界复杂度，可以先保留少量重复，待两个实现稳定后再提取。

## 11. 错误处理

两个 Provider 最终应统一转换以下错误类别：

```ts
type ModelInvocationErrorCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "quota_exhausted"
  | "context_overflow"
  | "invalid_request"
  | "content_filtered"
  | "model_unavailable"
  | "transport"
  | "stream_interrupted"
  | "provider_internal";
```

错误至少保留：

```ts
interface ModelInvocationError extends Error {
  category: ModelInvocationErrorCategory;
  retryable: boolean;
  retryAfterMs?: number;
  providerStatusCode?: number;
}
```

错误不得被转换成普通文本、空响应或其他成功形状。

## 12. 重试策略

第一阶段只实现受约束的请求级重试：

| 错误 | 行为 |
|---|---|
| 400 或参数错误 | 不重试 |
| 401/403 | 不重试 |
| Context overflow | 不在 Provider 内盲目重试 |
| 429 | 遵守 `Retry-After` 后有限重试 |
| 部分 5xx | 指数退避和 jitter |
| DNS/连接建立失败 | 有限重试 |
| 流中断 | 默认不自动重放整个 Turn |

第一阶段不实现 Anthropic 与 OpenAI 之间的自动接管。

## 13. 安全要求

1. API Key 不写入日志。
2. Headers 日志必须脱敏。
3. `baseURL` 必须是合法 HTTP/HTTPS URL。
4. 禁止 URL 中携带用户名和密码。
5. 错误信息不得包含完整 Authorization Header。
6. 自定义 Endpoint 不自动获得高信任模型能力。
7. 配置文件中的 API Key 仅作为兼容能力，不作为默认文档示例。

## 14. 测试草稿

### 14.1 Provider 合同测试

- 注册稳定 Provider ID；
- 发布不可变 Model Catalog；
- 缺少凭据时返回 `connection_missing`；
- 非法 Endpoint 启动失败；
- 拒绝 Catalog 外模型；
- Provider、Protocol、Model 和 Invocation Port 绑定一致；
- `deploymentFacts` 优先级正确；
- 配置和输出对象被冻结。

### 14.2 Client 测试

- 文本请求和文本流；
- System instructions；
- 多轮消息；
- Tool definition、Tool call 和 Tool result；
- 多个 Tool call；
- 图片输入；
- Usage；
- `end_turn`、`tool_use` 和 `max_tokens`；
- `AbortSignal`；
- Malformed SSE；
- 流缺少终止事件；
- 重复 Tool call ID；
- 认证失败；
- 429 和 5xx；
- Context overflow。

### 14.3 配置测试

- 拒绝旧的 `llm.apiKey`、`llm.baseURL` 和 `llm.deploymentFacts`；
- 仅配置 Anthropic；
- 仅配置 OpenAI；
- 同时配置两者；
- Provider 配置为空；
- 默认模型指向未注册 Provider；
- 未知 Provider 配置字段；
- 环境变量覆盖配置文件 Key；
- Extension Provider 不受 Built-in 配置影响。

### 14.4 架构适应性测试

- Core 不导入具体 Provider SDK；
- AgentRunner 不导入具体 Provider；
- Built-in Provider 只通过 `ModelInvocationPort` 暴露调用；
- OpenAI 和 Anthropic 相互不依赖；
- Runtime Composition 不引用 Copilot Relay 实现；
- Extension API 不暴露具体 Provider SDK 类型。

## 15. 实施阶段

### 阶段一：配置结构

- 增加 `llm.providers`；
- 删除旧的 `llm.apiKey`、`llm.baseURL` 和 `llm.deploymentFacts`；
- 对旧字段返回明确配置校验错误；
- 增加配置校验和环境变量解析；
- Runtime 按配置创建 Built-in Provider Unit。

### 阶段二：OpenAI Provider

- 新增 `OpenAICompatibleProvider`；
- 新增 `OpenAIResponsesClient`；
- 建立可扩展 Client Factory；
- 新增 Model Catalog 和 Tool Codec；
- 注册 Runtime Unit；
- 接入模型选择。

### 阶段三：协议行为完善

- 错误分类；
- 429/5xx 重试；
- Stop reason 和 Usage 归一；
- 自定义 Endpoint 能力事实校验。

### 阶段四：Chat Completions Client

- 新增 `OpenAIChatCompletionsClient` 和独立 Codec；
- 注册 `openai-chat-completions` 执行绑定；
- 增加模型与 Endpoint 的协议能力校验；
- 增加主流 OpenAI-compatible Endpoint 合同测试。

### 阶段五：收尾

- 更新配置和 Provider 文档；
- 运行 Unit、Integration、Fitness 和 Build；
- 仅在共享边界稳定后提取重复的 Responses 协议代码。

## 16. 待确认决策

实现前需要确认：

1. 是否采用 `anthropic-compatible` 和 `openai-compatible` 作为稳定 Provider ID；
2. API Key 是否继续允许直接写入配置文件；
3. OpenAI 第一版是否只交付 Responses Client，并为 Chat Completions 保留扩展点；
4. 官方 Endpoint 是否使用静态模型目录；
5. 自定义 Endpoint 是否必须提供 `deploymentFacts`；
6. 是否在第一版提取 Copilot Relay 的 Responses Codec；
7. 两个 Provider 同时配置时是否全部注册并出现在模型列表中。

## 17. 结论

本次不引入统一聚合 Provider，直接提供两个独立 Built-in Provider：

```text
anthropic-compatible
openai-compatible
```

配置、代码和 Registry 保持一一对应：

```text
llm.providers.<providerId>
  ↓
Provider Runtime Unit
  ↓
Provider Class
  ↓
Protocol Client
  ↓
ModelInvocationPort
```

该方案以较低的架构复杂度获得 Anthropic 和 OpenAI 双协议支持，同时保留未来增加其他 Built-in Provider、云平台 Provider 和 Extension Provider 的空间。
