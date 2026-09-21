# Runtime Steering 与 Runner 配置设计草稿

> 状态：非权威研究草稿
> 创建日期：2026-09-20
> 范围：Runtime steering 开关、Runtime/Runner 配置与默认值所有权、pending steering 批处理、Model 调用预算
> 后续工件：[Runtime Steering and Runner Configuration Archived Change](../changes/archive/runtime-steering-and-runner-configuration/plan.md)
> 约束：本文不授权实现；后续 Active Change 的 Plan 和 Specification 优先于本文，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> 当前讨论结论：Runtime owns steering policy/default；Runner owns Model-loop limits and safe injection points；新设计不提供旧字段兼容路径；`maxLlmCalls` 可选且默认无限制；显式上限保留现有终止逻辑，Client 根据现有 `stopReason` 提示；正常结束时迟到 steering 转入下一 Turn FIFO

## 1. 背景

本轮讨论从四个相关但需要分别判断的议题开始：

1. 将全局配置
   `runner.inTurnMessageMode: 'steer' | 'followup'`
   简化并迁移为 `runtime.steeringEnabled: boolean`；
2. 按项目已经确立的模块配置规则，分别调整 Runtime 与 Runner 配置 Contract、
   默认值和 Platform Configuration 之间的所有权与依赖方向；
3. 调研多条 pending steering message 应逐条处理、保留为多条消息后批量处理，
   还是先合并成一条文本再交给模型；
4. 调研 `maxLlmCalls=12` 是否应继续作为每个 Turn 的默认硬上限。

四个事项并不具有相同结论：

- 第一项确定新的用户可见配置形状；
- 第二项确定模块所有权与依赖方向；
- 第三项经事实核对后形成 no-change 结论；
- 第四项确定长任务的默认终止语义以及 steering 与调用预算的交互。

## 2. 当前实现

### 2.1 配置

当前 `RunnerConfig` 位于 Platform Configuration：

```ts
interface RunnerConfig {
  maxLlmCalls: number;
  inTurnMessageMode: 'steer' | 'followup';
}
```

`DEFAULT_AGENT_CONFIG.runner` 也位于 Platform Configuration，当前默认值为：

```ts
{
  maxLlmCalls: 12,
  inTurnMessageMode: 'followup'
}
```

### 2.2 Steering 路由

Runtime 只在以下两个条件同时满足时把新消息送入 steering inbox：

1. `inTurnMessageMode === 'steer'`；
2. 当前 Session 存在活动 Turn。

否则，新消息进入普通的 per-Session FIFO 队列，并在当前 Turn 完成后创建新
Turn。

Steering 当前只接受非空文本。它不会中断正在执行的 Model 请求或已经开始的
Tool Call，而是在一次 Model/Tool 循环结束后的安全边界被 Runner 读取。

### 2.3 多条 pending steering

当前实现并不是“每条 steering 调用一次模型”，而是：

1. Runtime 一次性取出 inbox 中当前存在的全部消息；
2. 按进入 inbox 的顺序生成多条独立 `user` message；
3. Runner 分别持久化这些消息；
4. 将完整批次加入下一次 Provider 请求；
5. 只执行一次 continuation Model 调用。

例如：

```text
A
B
C
```

会保留为：

```text
user(A)
user(B)
user(C)
```

而不是拼成：

```text
user("A\n\nB\n\nC")
```

因此，当前实现已经获得“一批 pending steering 只增加一次 Model 调用”的收益。

### 2.4 Model 调用上限

当前存在两层相同的默认值：

- Platform Configuration 的 `DEFAULT_AGENT_CONFIG.runner.maxLlmCalls=12`；
- AgentRunner 内部的 `DEFAULT_MAX_LLM_CALLS=12` fallback。

因此，即使配置没有显式提供该字段，一个 Turn 也最多执行 12 次 Model 调用。
首次调用、Tool Result 后的 continuation 和 steering 后的 continuation 都计入
同一个计数。达到上限时 Runner 返回 `stopReason='max_llm_calls'`。

当前检查顺序还有一个直接影响：Runner 可能已经从 Runtime 取出 pending
steering，但会在持久化和注入该批消息之前先检查调用上限。若此时已经达到 12，
Runner 直接结束，已取出的 steering 不会进入当前调用，也不会留在 Runtime
inbox。

## 3. 外部实现调研

### 3.1 OpenAI Codex

Codex 先检查是否存在 pending input，在合适边界一次性取出完整 pending
vector，再逐条记录为独立 user item，最后对该批次执行一次 sampling。

- [Pending input 批量取出](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/core/src/session/input_queue.rs#L291-L323)
- [逐条处理 pending item](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/core/src/session/turn.rs#L843-L890)
- [形成历史后执行一次 sampling](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/core/src/session/turn.rs#L496-L535)

Codex 的模式是：

```text
批量取出 + 保留消息边界 + 一次 continuation
```

### 3.2 Claude Code

Claude Code 允许用户在 Agent 工作时继续输入。Tool 执行完成后，符合条件的
queued messages 会在同一个 Turn 内交给 Claude。如果当前 Turn 在进入该边界
前已经结束，则只将最旧的一条消息提升为下一个 Turn，其余继续保留在队列中。

- [Claude Code queued message 行为](https://github.com/anthropics/claude-code/blob/bf7d404e26a5fb6167d21b46c93a2bf6c22ab274/docs/en/interactive-mode.md#L347-L358)

当前发行物中的实现证据表明，在 Tool 边界选中的消息分别包装，而不是先合并
为一条字符串。由于核心实现以压缩后的可执行文件发布，这项实现细节的证据
强度低于官方行为文档。

### 3.3 VS Code 与 GitHub Copilot

VS Code 管理的本地 Chat queue 会一次取出连续的 steering requests，并使用
两个换行符 `"\n\n"` 合并文本，然后发起一次 Chat Participant invocation。

- [Steering 优先级与队列顺序](https://github.com/microsoft/vscode/blob/498694978518be91f986b3110d972fc123c90b3b/src/vs/workbench/contrib/chat/common/model/chatModel.ts#L2594-L2622)
- [批量取出 steering requests](https://github.com/microsoft/vscode/blob/498694978518be91f986b3110d972fc123c90b3b/src/vs/workbench/contrib/chat/common/model/chatModel.ts#L2647-L2659)
- [使用 `"\n\n"` 合并](https://github.com/microsoft/vscode/blob/498694978518be91f986b3110d972fc123c90b3b/src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts#L2146-L2160)
- [合并行为测试](https://github.com/microsoft/vscode/blob/498694978518be91f986b3110d972fc123c90b3b/src/vs/workbench/contrib/chat/test/common/chatService/chatService.test.ts#L1090-L1102)

这可以证明 VS Code 发起一次 Participant invocation，但不能证明 Participant
内部只执行一次底层 Model HTTP 请求。使用 Agent Host 的 Session 由服务端管理
队列，因此也不能推断所有 Copilot 部署都使用相同的拼接方式。

相关提交说明，合并修复了“只发送第一条 steering，后续消息可能一直滞留”的
问题。减少调用次数可能是附带效果，但没有证据表明它是明确设计动机。

### 3.4 OpenCode

OpenCode 将用户消息分别持久化，并在每次循环时重新读取历史。下一次历史快照
能够同时看到多条新消息，但不会先进行 steering 专用的字符串拼接。

- [独立 user message 转换](https://github.com/anomalyco/opencode/blob/a97622c801f4ca571530ddc51076af659a9c32cd/packages/opencode/src/session/message-v2.ts#L195-L242)
- [循环中的历史读取](https://github.com/anomalyco/opencode/blob/a97622c801f4ca571530ddc51076af659a9c32cd/packages/opencode/src/session/prompt.ts#L1088-L1097)

### 3.5 pi coding agent

pi 的 pending queue 支持两种消费方式：

- `"one-at-a-time"`：一次取最旧一条，也是 steering 和 follow-up 的默认方式；
- `"all"`：一次取出全部消息，但仍保留为多条独立消息。

- [Pending queue 消费方式](https://github.com/earendil-works/pi/blob/b73412a3787abbc9427fd6f335b423c66e0e3fa8/packages/agent/src/agent.ts#L140-L168)
- [独立消息注入](https://github.com/earendil-works/pi/blob/b73412a3787abbc9427fd6f335b423c66e0e3fa8/packages/agent/src/agent-loop.ts#L208-L219)
- [`all` 模式测试](https://github.com/earendil-works/pi/blob/b73412a3787abbc9427fd6f335b423c66e0e3fa8/packages/coding-agent/test/suite/agent-session-queue.test.ts#L254-L278)

`"one-at-a-time"` 会让两条 pending steering 分别触发后续调用；`"all"` 则与
本项目当前行为更接近。

### 3.6 Model 调用与 Agent 循环上限

本轮没有在 Claude Code、OpenAI Codex、OpenCode 或 pi 中发现类似
`maxLlmCalls=12` 的默认、不可恢复、per-user-turn Model 调用硬上限：

| Agent | 已确认的主循环默认行为 |
|---|---|
| Claude Code | `maxTurns` 可选，默认没有限制 |
| OpenAI Codex | 主 Turn loop 未发现固定 Model sampling 次数上限 |
| OpenCode | `steps` 可选，未设置时使用 `Infinity` |
| pi | 未发现固定数字上限；提供可选 `shouldStopAfterTurn` 回调 |
| VS Code/Copilot | 提供可继续的 request checkpoint，不是不可恢复硬停止；默认值随版本、Surface 和实验配置变化 |

主要证据：

- [Claude Code Agent Loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)
- [Codex Turn Loop](https://github.com/openai/codex/blob/5c5308fc9a9ee789049d646ef11e5400384b9c6f/codex-rs/core/src/session/turn.rs#L423-L445)
- [OpenCode `steps ?? Infinity`](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/opencode/src/session/prompt.ts#L1170-L1180)
- [pi AgentLoopConfig](https://github.com/earendil-works/pi/blob/6dff740fab3f080858726ad727e2f4cbb93a8b1d/packages/agent/src/types.ts#L154-L167)
- [VS Code `chat.agent.maxRequests`](https://github.com/microsoft/vscode/blob/44825207bf4389c3bd17c92d3ec28cf784c324cc/src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts#L2947-L2965)
- [Copilot 达到阈值后的确认路径](https://github.com/microsoft/vscode/blob/44825207bf4389c3bd17c92d3ec28cf784c324cc/extensions/copilot/src/extension/prompt/node/defaultIntentRequestHandler.ts#L324-L335)

其他产品更常见的是分别限制失败重试、Model Context、输出 Token、单次请求或
Tool 超时、Subagent 深度与并发，或者提供可选执行预算。这些限制不等同于一个
固定的成功 Model 调用次数上限。

## 4. 设计结论一：Steering 全局开关

确认配置为：

```ts
interface RuntimeConfig {
  readonly steeringEnabled: boolean;
}
```

确认语义：

| 条件 | 行为 |
|---|---|
| 无活动 Turn | 正常进入 per-Session 队列 |
| 有活动 Turn，`steeringEnabled=false` | 进入队列，当前 Turn 完成后创建新 Turn |
| 有活动 Turn，`steeringEnabled=true` | 非空文本进入当前 Turn 的 steering inbox |

默认值采用 `false`；其可观察结果与当前默认的 follow-up queue 行为一致。

新设计使用 `runtime.steeringEnabled`，不包含
`runner.inTurnMessageMode`。Steering 的启用判断、活动 Turn 识别、消息分类和
inbox 都由 Runtime 实现；把该字段放在 `runner` 下会让公开配置名称与实际行为
所有者不一致。

不提供旧字段 alias、迁移器、冲突规则或旧字段专用错误。原始文档中的非 Contract
字段是否报错，只遵循 Platform Configuration 的通用未知字段规则，不形成
steering 专用兼容逻辑。

名称使用 `steeringEnabled`，表示用户是否启用该策略；不使用
`supportsSteering`，因为后者通常表示 Runtime 或 Channel 的客观能力，而当前
Runtime 本身始终具备 steering 实现。

本设计不增加：

- Channel 级或逐消息 `steer` / `queue` 选择；
- WebSocket 协议字段；
- HTML 或 CLI 操作按钮与快捷键；
- Channel capability；
- Model 或 Tool 中断。

## 5. 设计结论二：配置与默认值所有权

当前讨论采用以下方向，并在未来提升为 Active Change 时进入正式评审：

- Runtime 拥有 `RuntimeConfig` 和 `steeringEnabled=false` 默认值；
- Runner 拥有 `RunnerConfig` 和 Model/Tool 循环相关的配置语义；
- Platform Configuration 导入 Runtime 与 Runner 的 leaf Contract 和默认值；
- Platform Configuration 继续负责顶层文档组合、严格校验、优先级合并和不可变
  application projection；
- Runtime 和 Runner 都不读取配置文件、不读取环境变量，也不反向依赖
  Platform Configuration。

依赖方向为：

```text
core/runner
  └─ owns RunnerConfig and Model-loop limits

runtime
  └─ owns RuntimeConfig, steering routing, inbox, and default

platform/config
  └─ imports and composes Runtime-owned and Runner-owned leaf configs
```

该规则虽然已经在稳定 Configuration Specification 中确立，但上一个 Built-in
LLM Provider Change 明确没有迁移非 LLM 模块。本轮如果实施 Runtime/Runner
的所有权迁移，仍需单独批准，不能把它视为上一 Change 已授权的遗留工作。

公开配置组合采用：

```ts
interface AgentDefaults {
  readonly runtime: RuntimeConfig;
  readonly runner: RunnerConfig;
  // other module configs
}
```

这里的“模块拥有配置”只表示模块定义字段、类型、行为约束与默认值，不表示模块
自行读取 `config.json`。物理读取、Schema 校验、precedence merge 和 immutable
projection 仍只属于 Platform Configuration。

本范围不扩大到 Memory、Prompt、Context、Compaction、Subagent 或其他模块的配置迁移。

## 6. 设计结论三：Pending steering 批处理

确认保持当前行为：

1. 在一个安全边界取得当前可见的全部 steering；
2. 保持 Session 内 FIFO；
3. 每次提交继续作为独立 user message；
4. 每条消息分别持久化；
5. 整个 ready batch 只触发一次 immediate continuation Model 调用；
6. batch snapshot 之后到达的消息留到下一个安全边界。

不采用 `"\n"` 或 `"\n\n"` 拼接，原因是：

- 当前实现已经只调用一次 Model，不需要通过拼接减少调用次数；
- 独立消息保留准确的用户提交边界；
- 独立记录更利于审计、重放和未来附加 message metadata；
- 拼接会使原始边界只能依赖文本分隔符推断；
- Provider 如有相邻同角色消息限制，应只在 Provider wire adapter 中派生兼容
  表示，不应改变 canonical Session history。

因此，第三项当前是调研确认后的 **no-change 结论**，本身不需要生产修改。

## 7. 设计结论四：可选 Model 调用预算

当前讨论确认保留用户显式限制长任务的能力，但移除默认硬上限：

```ts
interface RunnerConfig {
  readonly maxLlmCalls?: number;
}
```

确认语义：

- 未配置 `maxLlmCalls` 时，不施加 Model 调用次数限制；
- 配置正整数时，它仍是该 Turn 的显式硬上限；
- 删除 AgentRunner 内部隐藏的 `12` 次 fallback；
- Model Context、Token、超时、Abort、Tool Policy 和 Compaction 继续独立生效；
- Provider transport retry 不计作新的语义 Model round。

本设计不引入 soft limit、自动递增预算、Continue 交互或隐藏 emergency fuse。
这些机制需要新的 Channel/交互 Contract，超出当前简单配置目标。

达到显式上限时保留现有终止逻辑：

- 返回最后一次 Model 调用的 `text` 和 `content`；
- `stopReason` 为 `'max_llm_calls'`；
- 保留累计 Usage 和 Tool round 数；
- 已从 Runtime inbox 取出但尚未注入的 steering 被丢弃；
- 不新增 `RunResult` 字段或新的终止事件。

客户端可以仅根据现有 `stopReason` 显示通用提醒，例如：

```text
Turn stopped after reaching the configured LLM call limit.
```

在不改变结果 Contract 的前提下，客户端无法获知准确的 dropped steering 数量，
因此新设计不承诺显示 `n messages dropped`。提醒也不应拼接到模型生成的
assistant `text` 或 `content`，以免污染 Session history。

当前讨论确认采用这一最小方式：Core 和 Runtime 不新增结果字段，HTML、CLI
以及其他客户端可以根据已有的 `stopReason='max_llm_calls'` 显示通用系统提示。

## 8. 纳入范围的正常结束边界

当前存在一个窄窗口：

1. Runner 已完成最后一次 steering inbox 读取；
2. Runtime 仍将 Session 标记为存在活动 Turn；
3. 新消息因此被广播并归类为 `deliveryMode='steering'`；
4. Runner 已经不会再次读取；
5. Runtime 在 Turn cleanup 时删除未读 inbox。

该消息可能既没有注入当前 Turn，也没有转成下一 Turn。

这不是第三项“是否合并消息”的一部分，而是另一个生命周期问题。

当前讨论确认采用以下交接规则：

```text
在当前 Turn 最终安全边界前被选中
  → 注入当前 Turn

没有赶上当前 Turn 的最终安全边界
  → 按原接受顺序转入下一 Turn 的 FIFO 队列

显式 Abort
  → 保持现有丢弃语义

达到显式 maxLlmCalls
  → 保持现有丢弃语义
```

正常结束不强制额外 continuation。否则任何稍晚到达的消息都可能再次延长当前
Turn，使完成边界无法稳定。未来实现需要为“仍接收 steering”和“只接收下一
Turn queue”定义明确的线性化交接点，并保留原消息身份、顺序与 route context。

## 9. 分类判断

### 9.1 Steering 全局开关

`runner.inTurnMessageMode` 改为 `runtime.steeringEnabled` 会改变用户可见的
`config.json` Contract。根据 Development Workflow，即使实现改动很小，也
不能仅按代码量归类为 Small Change。

### 9.2 配置与默认值所有权

Runtime 与 Runner 配置和默认值的迁移会改变模块所有权和依赖方向，应作为
Architecture Slice 审批。

### 9.3 Pending steering 批处理

当前行为已经满足确认规则，不需要生产修改。只需保留本调研结论，避免为了模仿
VS Code 而引入不必要的字符串拼接。

### 9.4 可选 Model 调用预算

将 `maxLlmCalls` 从必填默认硬上限改为可选预算，会改变正常 Turn 的终止语义，
也会影响配置 Contract，因此不属于 Small Change。

当前讨论已确认未配置 `maxLlmCalls` 时不设置 Model 调用次数上限。

### 9.5 后续组合方式

Steering 全局开关、配置所有权、可选 Model 调用预算和第 8 节的正常结束交接
共同进入一个范围较窄的 Active Architecture Slice：

- 前三项共同修改 Runtime/Runner 的公共配置 Contract、默认值及其所有权；
- 正常结束交接是 steering 生命周期中已经确认要修复的可观察行为；
- pending steering 批处理本身保持 no-change，只需要 Contract/回归测试防止
  后续误改为逐条调用或字符串拼接。

## 10. 当前讨论结论

1. 新设计使用 `runtime.steeringEnabled`，默认 `false`。
2. Runtime owns steering policy、routing、inbox 和默认值；Runner owns
   Model-loop limits 与 safe injection points。
3. 不保留 `runner.inTurnMessageMode`，也不增加旧字段兼容或专用拒绝逻辑。
4. Pending steering 保持多条独立消息、FIFO，并在一个安全边界形成一次
   continuation Model 调用；不进行换行拼接。
5. `runner.maxLlmCalls` 为可选显式预算，未配置时不设置调用次数上限。
6. 达到显式 `maxLlmCalls` 时保留当前结果语义和 pending steering 丢弃行为；
   Client 根据现有 `stopReason='max_llm_calls'` 显示通用提示。
7. 正常 Turn 结束时，没有赶上最终注入边界的 steering 转入下一 Turn FIFO；
   不静默丢弃，也不强制延长当前 Turn。
8. 显式 Abort 的现有 steering 丢弃语义不变。

上述设计选择已经完成，没有剩余产品行为候选项。尚未确定的是实现层面的
线性化机制、类型位置、事件展示细节和验证矩阵；这些内容应在正式 Plan 与
Specification 中设计和评审。

本文仍属于 Research Draft，不授权实现。下一步是提升为 Active Architecture
Slice，建立 Proposed Plan 和 Draft Specification，再由项目所有者评审、接受并
另行批准 Delivery。

遵循 [Development Workflow](../governance/development-workflow.md)。
