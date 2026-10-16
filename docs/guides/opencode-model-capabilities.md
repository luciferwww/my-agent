# OpenCode Go 模型能力参考

> 状态：外部能力参考快照，不是项目实现契约
> 核对日期：2026-10-16
> 范围：OpenCode Go 模型列表、协议、推理开关、推理强度与 builtin 配置映射

本文面向通过 `my-agent` 接入 OpenCode Go 的用户。模型可用性、协议和参数
可能随服务更新；表格用于准备候选配置，不代表所有模型及参数已经实测。
项目配置契约以 [Configuration Specification](../specifications/configuration.md)
为准，操作说明见 [Configuration Guide](configuration.md)。

## 1. 信息来源与可信边界

| 来源 | 本文使用的信息 | 不能据此确认的信息 |
|---|---|---|
| [Go 模型列表](https://opencode.ai/zen/go/v1/models) | 当前返回的精确模型 ID，共 37 个 | 协议、推理开关、effort、额度或实际调用权限 |
| [Go 官方文档](https://opencode.ai/docs/go/) | 模型端点、SDK 类型、订阅和会话头要求 | 未逐模型列明的推理参数 |
| [OpenCode 中文模型文档](https://opencode.ai/docs/zh-cn/models/) | 模型配置、变体与推理选项的一般说明 | 每个 Go 模型的精确档位；不能把通用示例套用到全部模型 |
| [Models.dev API](https://models.dev/api.json) | `opencode-go.models` 下的 `reasoning`、`reasoning_options` 和端点元数据 | 当前网关对每个参数的实际接受情况 |

OpenCode 模型文档说明其使用 Models.dev。本文只采用其中 `opencode-go`
提供商的对应模型记录，不把其他供应商的同名模型能力当作 Go 的能力。

少数仍出现在模型列表中的旧模型，没有当前元数据或端点记录。表中明确保留
“未确认”，而不是猜测或将缺失解释为不支持。标有 `†` 的协议仅有本次讨论
早先提供的 Go 端点截图作为依据，当前端点表未列出，正式使用前需要复核。

## 2. 协议与端点

| 表格简写 | builtin 的 `protocol` | 最新文档中的 API 前缀 | 操作路径 |
|---|---|---|---|
| Chat | `openai-chat-completions` | `https://opencode.ai/inference/go/openai/v1` | `/chat/completions` |
| Responses | `openai-responses` | `https://opencode.ai/inference/go/openai/v1` | `/responses` |
| Messages | `anthropic-messages` | `https://opencode.ai/inference/go/anthropic/v1` | `/messages` |
| Google | 当前 builtin 不支持 | `https://opencode.ai/inference/go/google/v1beta` | 模型相关的 Google 原生操作 |

此前测试成功的是旧入口
`https://opencode.ai/zen/go/v1/chat/completions`，模型为 `glm-5.2`。
这只能证明当时该模型的基础调用成功，不能证明旧入口支持表中所有模型、
所有协议或所有推理参数。

当前 builtin 使用一组 `baseURL` 和凭据，并支持模型级相对 `endpoint`。
可将共享地址设为 `https://opencode.ai/inference/go`，分别配置
`openai/v1/responses`、`openai/v1/chat/completions` 和
`anthropic/v1/messages`，以使用这三种协议。未配置 `endpoint` 时，仍沿用
协议默认路径；不能把不同路径的模型直接混入一个不匹配的协议前缀。
该能力不绑定 OpenCode，也适用于 `responses` 与 `v1/responses` 等路径差异。
Google 原生模型仍不在 builtin 支持范围内；本文不推断旧统一入口的兼容范围。
完整混合协议示例见 [Configuration Guide](configuration.md#opencode-go-example)。

## 3. 推理能力的含义

- **推理支持**：元数据的 `reasoning: true`，表示模型具有推理能力。
- **独立 Thinking 开关**：`reasoning_options` 明确列出 `toggle`，可登记
  `thinking: ["on", "off"]`。
- **Reasoning effort**：元数据明确列出的强度选项，不是通用固定枚举的全部值。
- **`none`**：某些模型通过 effort 表达无推理；它不等于元数据存在独立
  Thinking 开关。
- **未列出**：有模型记录，但没有列出该控制能力；不代表能力不存在。
- **未确认**：没有找到对应的 `opencode-go` 模型记录。

模型能够输出推理，不代表调用方能关闭推理，也不代表可以任意设置 effort。
这些声明也不规定是否向用户展示思考内容。

## 4. 模型能力表

所有 ID 均来自核对日的实时列表。Thinking 开关和 effort 来自上述元数据，
不是对网关进行参数探测得到的结果。

| modelId | 协议 | 推理支持 | 独立 Thinking 开关 | Reasoning effort |
|---|---|---|---|---|
| `deepseek-v4.1-flash` | Chat | 是 | 未列出 | `low, high, max` |
| `deepseek-v4-pro` | Chat | 是 | 未列出 | `high, max` |
| `glm-5.1` | Chat † | 未确认 | 未确认 | 未确认 |
| `glm-5.2` | Chat | 是 | 未列出 | `high, max` |
| `glm-5.3` | Chat | 是 | 未列出 | `low, high, max` |
| `glm-5.3-flash` | Chat | 是 | 未列出 | `low, high, max` |
| `grok-4.6` | Responses | 未确认 | 未确认 | 未确认 |
| `grok-4.7` | Responses | 是 | 未列出 | `low, medium, high, xhigh` |
| `muse-spark-1.2-contributor` | Responses | 是 | 未列出 | `minimal, low, medium, high, xhigh` |
| `muse-spark-1.3-contributor` | Responses | 是 | 未列出 | `minimal, low, medium, high, xhigh` |
| `omen-alpha` | 未确认 | 未确认 | 未确认 | 未确认 |
| `gpt-5.6-luna` | Responses | 是 | 未列出；effort 含 `none` | `none, low, medium, high, xhigh, max` |
| `gpt-6-luna` | Responses | 是 | 未列出；effort 含 `none` | `none, low, medium, high, xhigh, max` |
| `claude-haiku-5-5` | Messages | 是 | `on / off` | `low, medium, high, xhigh, max` |
| `hy3` | Chat | 是 | 未列出；effort 含 `none` | `none, low, high` |
| `hy4-preview` | Chat | 是 | 未列出；effort 含 `none` | `none, high` |
| `kimi-k2.6` | Chat | 未确认 | 未确认 | 未确认 |
| `kimi-k2.7-code` | Chat | 是 | 未列出 | 未列出 |
| `kimi-k3` | Chat | 是 | 未列出 | `max` |
| `mimo-v2.5` | Chat | 是 | 未列出 | 未列出 |
| `mimo-v2.6-flash` | Chat | 是 | 未列出 | 未列出 |
| `mimo-v2.5-pro` | Chat | 是 | 未列出 | 未列出 |
| `mimo-v2.6-pro` | Chat | 是 | 未列出 | 未列出 |
| `minimax-m2.5` | Messages † | 未确认 | 未确认 | 未确认 |
| `minimax-m2.7` | Messages | 是 | 未列出 | 未列出 |
| `minimax-m3` | Messages | 是 | `on / off` | 未列出 |
| `gemini-4-argon-contributor` | Google | 是 | 未列出 | `low, medium, high` |
| `space-bunny` | Chat | 是 | 未列出 | `low, medium, high, xhigh, max` |
| `longcat-2.0` | Chat | 是 | `on / off` | 未列出 |
| `longcat-2.5-preview-free` | Chat | 是 | `on / off` | 未列出 |
| `step-5-preview` | Chat | 是 | 未列出 | `low, medium, high` |
| `cat-jam-free` | Chat | 是 | 未列出 | `low, medium, high, xhigh, max` |
| `qwen3.6-plus` | Messages † | 未确认 | 未确认 | 未确认 |
| `qwen3.7-max` | Messages † | 未确认 | 未确认 | 未确认 |
| `qwen3.8-max` | Messages | 是 | `on / off` | `low, medium, xhigh` |
| `qwen3.8-flash` | Messages | 是 | `on / off` | `low, medium, xhigh` |
| `qwen3.7-plus` | Messages | 是 | `on / off` | 未列出 |

特别注意：

- `qwen3.8-max` 和 `qwen3.8-flash` 列出的是 `low, medium, xhigh`，没有 `high`。
- `kimi-k3` 只列出 `max`，不能凭同系列其他模型推导更多档位。
- Qwen 部分记录还列出 `budget_tokens`；当前项目的模型能力配置没有该字段。
- 未确认模型的控制能力应省略，不填写猜测值。

## 5. 映射到 builtin 配置

以下是按元数据准备的候选配置，不代表已经完成 OpenCode Go 接入验证。
使用现有配置字段，不将 OpenCode 客户端自己的 `variants` 或
`reasoningEffort` 配置结构直接复制到 `my-agent`。

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "glm-5.2"
    },
    "builtin": {
      "baseURL": "https://opencode.ai/inference/go/openai/v1",
      "apiKey": "${OPENCODE_API_KEY}",
      "models": [
        {
          "modelId": "glm-5.2",
          "protocol": "openai-chat-completions",
          "reasoning": {
            "efforts": ["high", "max"]
          }
        },
        {
          "modelId": "gpt-5.6-luna",
          "protocol": "openai-responses",
          "reasoning": {
            "efforts": ["none", "low", "medium", "high", "xhigh", "max"]
          }
        }
      ]
    }
  }
}
```

`reasoning` 登记可供选择的能力，不自动为每次调用选择默认档位。对于独立支持
开关的模型，可按元数据登记 `thinking: ["on", "off"]`；没有依据时省略。
不应把没有精确 token 上限数据的模型补成猜测的上下文或输出上限。

能力声明与请求编码必须分开验证。例如，模型支持 Thinking 并不自动意味着
它接受客户端发送的 `thinking.type: "adaptive"`。相同协议下，不同网关对
开关、effort、预算和工具调用组合仍可能有不同约束。

## 6. 凭据、会话与缓存

- Go 模型需要有效的 Go 或 Go Plus 订阅；能够读取模型列表不代表有调用权限。
- `apiKey` 已支持精确的 `${OPENCODE_API_KEY}` 环境变量引用，不要在文档或
  受版本控制的配置中保存实际 Key。
- 官方要求使用客户端自己的 User-Agent，以及每个对话稳定的
  `x-opencode-session`，以优化路由和 Prompt 缓存；没有要求 ID 必须是 UUID。
- 会话 ID 不是推理开关，不替代历史消息，也不保证缓存命中。缓存可能减少重复
  输入计算、降低首字延迟；费用或额度收益取决于对应模型的缓存价格与计量规则。

本项目相关实现和验证记录见
[Built-in Endpoint and Session Affinity Support Change](../changes/active/llm-session-affinity/specification.md)
及其 [Plan](../changes/active/llm-session-affinity/plan.md)。
传输与配置行为已通过聚焦自动化测试；未据此宣称所有模型已通过实网测试。
调用方不传 Session ID 时使用 UUID；这是项目的兜底规则，
不是 OpenCode 对会话 ID 格式的要求。

## 7. 使用前核对清单

1. 重新查询模型列表，确认精确 ID 仍存在。
2. 对照当前 Go 文档确认协议与 API 前缀，尤其是表中标记 `†` 的旧模型。
3. 先验证基础调用，再分别验证 Thinking 开关、各 effort 和所需工具能力。
4. 需要图片、PDF、视频或其他输入时，另行核实该模型与协议的媒体能力。
5. 确认项目客户端实际发送的参数形状被网关接受，而不只是配置校验通过。
6. 保留文档快照日期与测试范围；基础调用成功不升级为全能力验证通过。
