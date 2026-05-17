# Agent Runner 模块设计文档

> 创建日期：2026-04-02  
> 参考：相关执行引擎分析（详见 [openclaw-agent-runner-analysis.md](../analysis/openclaw/openclaw-agent-runner-analysis.md)）

---

## 1. 概述

Agent Runner 是执行引擎，串联所有已有模块，完成一次完整的对话循环。

**职责**：
- 编排 workspace + prompt-builder + session + llm-client
- 实现 tool use loop（LLM 请求工具 → 执行 → 返回结果 → LLM 继续）
- 消息持久化（用户消息 + 助手回复存入 session）
- 负责上下文预算管理、压缩触发判断、压缩编排与重试

**不属于 Agent Runner 的职责**：
- 工具的注册和定义（未来的 tools 模块）
- 配置加载与解析（应由 runtime 层完成后显式传入）
- 渠道消息接收和回复（无多渠道）
- 模型 fallback（后续优化）

上下文压缩的职责边界如下：

- Agent Runner 负责在真实执行路径中做 token 预算判断，并决定继续、裁剪还是触发摘要压缩
- `src/core/runner/context/*` 负责裁剪、估算、摘要生成等具体实现
- Session 负责压缩记录的持久化与读取，不负责压缩时机决策

压缩的详细流程、类型和持久化约束见 [core-runner-context-design.md](./core-runner-context-design.md)。

### 配置边界

Agent Runner 原则上不应直接访问 config。

具体来说：

- 不应直接调用 `loadConfig()` 或 `resolveAgentConfig()`；
- 不应通过 `process.env` 自行读取关键运行配置；
- 不应依赖完整 `AgentDefaults` 作为常规输入。

Runtime 层应先完成配置解析，再把 Agent Runner 真正需要的最小输入显式传入，例如：

- `model`
- `maxTokens`
- `maxLlmCalls`
- `systemPrompt`
- `tools`

这样 Agent Runner 才能保持为一个纯执行引擎，而不是半个应用入口。

> Note：本模块只保留“单次对话执行器”这一个职责边界。它直接依赖 `llm-client`、`session` 和工具执行回调，不承担入口装配、配置解析、多渠道接入或更复杂的平台级运行逻辑。

### 消息注入模式（Steering / FollowUp）

Agent Runner 在“同一 turn 尚未结束时收到新消息”的场景下，支持由 Runtime 传入配置来决定采用哪种注入策略：

- `steer`：优先作为 steering 注入当前执行流（内层循环的工具执行后检查并注入）
- `followup`：优先作为 followUp 排队（内层循环结束后检查并进入下一轮外层循环）

该模式属于运行策略，不改变 Agent Runner 的职责边界：

- 配置解析仍由 Runtime 完成；
- Agent Runner 只接收“已解析后的模式值”并按既定注入点执行；
- 是否启用自动判定（如按消息紧急性）由 Runtime 决策，不在 Runner 内部做业务语义判断。

详细规则与流程见 [steering-followup-design.md](./steering-followup-design.md)。

---

## 2. 目录结构

```
src/
└── agent-runner/
    ├── index.ts              # 公共入口
    ├── types.ts              # AgentRunnerConfig, RunParams, RunResult 等类型
    └── AgentRunner.ts        # 主类
```

---

## 3. 类型系统

```typescript
// agent-runner/types.ts

import type { LLMClient, ChatContentBlock, StreamEvent, TokenUsage } from '../llm-client/types.js';
import type { SessionManager } from '../session/SessionManager.js';

/** 工具执行结果 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 工具执行回调 */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

/** AgentRunner 构造参数 */
export interface AgentRunnerConfig {
  llmClient: LLMClient;
  sessionManager: SessionManager;
  /** 工具执行回调，不提供则 tool_use 时返回错误 */
  toolExecutor?: ToolExecutor;
  /**
   * 运行时事件回调（统一入口）。
   * RuntimeApp 在 bootstrap 时注入 fanout 闭包，由它转发事件到所有已注册 channel
   * 与可选的 RuntimeAppOptions.onAgentEvent 观察者；详见 adapters-channel-design.md §9.5。
   * 库消费者直接使用 AgentRunner 时也可在此注入自己的 handler。
   */
  onEvent?: (event: AgentEvent) => void;
}

/** 单次 run 的参数 */
export interface RunParams {
  /** Session key */
  sessionKey: string;
  /** 用户消息文本 */
  message: string;
  /** 模型名称，如 'claude-sonnet-4-6' */
  model: string;
  /** System prompt（由调用方通过 prompt-builder 构建） */
  systemPrompt: string;
  /**
   * 本次 turn 的唯一 id；由 RuntimeApp 生成并传入。
   * AgentRunner 用于：
   *   - emit 时自动注入到每个 AgentEvent
   *   - 触发 before/after_tool_call hook 时注入 payload
   * 直接调用 AgentRunner 的库消费者需自行生成 UUID。
   */
  turnId: string;
  /** 工具定义（传给 LLM，让它知道有哪些工具可用） */
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 单次 run 允许的最大 LLM 调用次数，默认 12 */
  maxLlmCalls?: number;
  /**
   * turn 内新消息注入模式（由 Runtime 解析配置后传入）。
   * - 'steer': 新消息优先进入 steering
   * - 'followup': 新消息优先进入 followUp
   */
  inTurnMessageMode?: 'steer' | 'followup';
}

/** 单次 run 的结果 */
export interface RunResult {
  /** 助手最终回复的文本 */
  text: string;
  /** 助手回复的完整 content blocks */
  content: ChatContentBlock[];
  /** stop reason */
  stopReason: string;
  /** 累计 token 用量（所有 LLM 调用的总和） */
  usage: TokenUsage;
  /** tool use 循环了几轮（所有外层迭代的总和） */
  toolRounds: number;
}

/**
 * 运行时事件。
 *
 * 每个变体都自带 `sessionKey` 和 `turnId` 字段（不引入公共基类型抽象）——
 * AgentRunner.emit 内部通过私有的分发式 Omit 类型作为输入，从 currentParams
 * 自动注入这两个字段，调用方不必手写。详见 adapters-channel-design.md §9.2。
 */
export type AgentEvent =
  | { type: 'run_start'; sessionKey: string; turnId: string }
  | { type: 'text_delta'; sessionKey: string; turnId: string; text: string }
  | { type: 'tool_use'; sessionKey: string; turnId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; sessionKey: string; turnId: string; name: string; result: ToolResult }
  | { type: 'llm_call'; sessionKey: string; turnId: string; round: number }
  | { type: 'run_end'; sessionKey: string; turnId: string; result: RunResult }
  | { type: 'error'; sessionKey: string; turnId: string; error: Error };
```

---

## 4. AgentRunner 核心逻辑

```typescript
class AgentRunner {
  constructor(config: AgentRunnerConfig);

  /**
   * 执行一次完整的对话。
   *
   * 流程：
   * 1. 从 session 加载历史消息
   * 2. 调用 LLM（带 system prompt + 历史 + 用户消息）
   * 3. 如果 content 中有 tool_use blocks → 调用 toolExecutor → 把结果加入消息 → 回到步骤 2
  * 4. 循环直到 content 中没有 tool_use blocks，或达到 maxLlmCalls
   * 5. 每条消息产生时立即保存到 session
   * 6. 返回最终结果
   */
  async run(params: RunParams): Promise<RunResult>;
}
```

### Tool Use Loop 流程

```
run(params)
  │
  ├─ onEvent({ type: 'run_start' })
  │
  ├─ 从 session 加载历史消息
  │   └─ sessionManager.getMessages(sessionKey)
  │       └─ 从 leafId 沿 parentId 回溯 → 线性消息列表
  │
  ├─ 保存用户消息到 session
  │   └─ sessionManager.appendMessage(sessionKey, { role: 'user', content: message })
  │
  ├─ 用户消息 push 到 messages 数组
  │
  │  ┌─────────── 两层循环（对齐 pi-agent-core 的 runLoop） ──────────┐
  │  │                                                                │
  │  │  参考 pi-agent-core：                                          │
  │  │  - 外层处理 followUp                                            │
  │  │  - 内层处理 tool calls + steering                               │
  │  │  - maxLlmCalls 是总 LLM 调用次数上限                            │
  │  │                                                                │
  │  │  llmCallCount = 0                                               │
  │  │  totalToolRounds = 0   ← RunResult.toolRounds 返回此值          │
  │  │                                                                │
  │  │  外层 while (true):  ← 预留给 followUp                        │
  │  │    │                                                           │
  │  │    │  hasMoreToolCalls = true  ← 初始 true，保证至少一次 LLM 调用│
  │  │    │                                                           │
  │  │    │  内层 while (hasMoreToolCalls):  ← 处理 tool calls        │
  │  │    │    │                                                      │
  │  │    │    ├─ 安全检查：llmCallCount >= maxLlmCalls?              │
  │  │    │    │  └─ YES → return(stopReason='max_llm_calls')         │
  │  │    │    ├─ onEvent({ type: 'llm_call', round: llmCallCount }) │
  │  │    │    ├─ llmCallCount++                                      │
  │  │    │    │                                                      │
  │  │    │    ├─ 遍历 llmClient.chatStream({                        │
  │  │    │    │    model, system, messages, tools                    │
  │  │    │    │  })                                                  │
  │  │    │    │  ├─ text_delta → onEvent + 收集文本                  │
  │  │    │    │  ├─ tool_use → 收集工具调用                          │
  │  │    │    │  ├─ message_end → 记录 usage                        │
  │  │    │    │  └─ error → 抛出                                    │
  │  │    │    │                                                      │
  │  │    │    ├─ assistant 消息 push 到 messages                    │
  │  │    │    ├─ 保存 assistant 消息到 session                      │
  │  │    │    │                                                      │
  │  │    │    ├─ stopReason === 'error' / 'aborted'?                │
  │  │    │    │  └─ YES → return 退出整个函数                       │
  │  │    │    │                                                      │
  │  │    │    ├─ 检查 content 中有 tool_use blocks?                  │
  │  │    │    │  ├─ NO → hasMoreToolCalls = false                   │
  │  │    │    │  └─ YES:                                            │
  │  │    │    │      ├─ 遍历执行工具                                │
  │  │    │    │      │  ├─ onEvent({ type: 'tool_use' })            │
  │  │    │    │      │  ├─ toolExecutor(name, input)                │
  │  │    │    │      │  └─ onEvent({ type: 'tool_result' })         │
  │  │    │    │      ├─ toolResult push 到 messages                 │
  │  │    │    │      ├─ 保存 toolResult 到 session                  │
  │  │    │    │      └─ totalToolRounds++                           │
  │  │    │    │                                                      │
  │  │    │  内层退出（hasMoreToolCalls = false）                     │
  │  │    │                                                           │
  │  │    ├─ 检查 followUp 消息（当前预留，返回空）                    │
  │  │    │  ├─ 有 → continue 外层                                   │
  │  │    │  └─ 无 → break 退出外层                                  │
  │  │                                                                │
  │  └────────────────────────────────────────────────────────────────┘
  │
  ├─ 构建 RunResult
  │
  ├─ onEvent({ type: 'run_end', result })
  │
  └─ return result
```

---

## 5. 消息流和 Session 持久化

每条消息在产生时立即保存到 session，而不是等全部结束后批量保存：

```
时间线：
  ├─ appendMessage('user', '用户输入')                ← 用户消息立即保存
  ├─ LLM 调用 #1
  ├─ appendMessage('assistant', [text + tool_use])    ← 助手回复立即保存
  ├─ appendMessage('toolResult', [tool_result])       ← 工具结果立即保存（独立 role，与 pi-ai 一致）
  ├─ LLM 调用 #2
  ├─ appendMessage('assistant', [text])               ← 最终回复立即保存
  └─ 返回结果
```

> 注意：session 中存储为 `role: 'toolResult'`（与 pi-ai 一致），发送给 Anthropic API 时由 agent-runner 转换为 `role: 'user'` + `tool_result` content blocks。

---

## 6. 使用示例

### 基本对话（无工具）

```typescript
import { AgentRunner } from './agent-runner';
import { AnthropicClient } from './llm-client';
import { SessionManager } from './session';
import { SystemPromptBuilder } from './prompt-builder';
import { ensureWorkspace, loadContextFiles } from './workspace';

// 初始化
const llmClient = new AnthropicClient({ apiKey: 'key', baseURL: 'http://localhost:5000' });
const sessionManager = new SessionManager('./my-project');
const runner = new AgentRunner({ llmClient, sessionManager });

// 准备
await ensureWorkspace('./my-project');
await sessionManager.createSession('main');
const contextFiles = await loadContextFiles('./my-project');
const systemPrompt = new SystemPromptBuilder().build({ contextFiles });

// 运行
const result = await runner.run({
  sessionKey: 'main',
  message: 'Hello!',
  model: 'claude-sonnet-4-6',
  systemPrompt,
});

console.log(result.text);
```

### 带工具（dummy executor）

```typescript
const runner = new AgentRunner({
  llmClient,
  sessionManager,
  toolExecutor: async (toolName, input) => {
    console.log(`Tool called: ${toolName}`, input);
    return { content: `Result of ${toolName}` };
  },
  onEvent: (event) => {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    if (event.type === 'tool_use') console.log(`\n[Tool: ${event.name}]`);
  },
});

const result = await runner.run({
  sessionKey: 'main',
  message: 'What is the weather today?',
  model: 'claude-sonnet-4-6',
  systemPrompt,
  tools: [
    { name: 'get_weather', description: 'Get current weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
  ],
  maxLlmCalls: 5,
});
```

### 多轮对话

```typescript
// 第一轮
await runner.run({ sessionKey: 'main', message: 'My name is Alice.', model, systemPrompt });

// 第二轮（session 自动带上历史）
const result = await runner.run({ sessionKey: 'main', message: 'What is my name?', model, systemPrompt });
console.log(result.text); // → "Your name is Alice."
```

---

## 7. 实施步骤

### Step 1 · types.ts
- [ ] ToolResult / ToolExecutor
- [ ] AgentRunnerConfig
- [ ] RunParams / RunResult
- [ ] AgentEvent

### Step 2 · AgentRunner.ts
- [ ] 构造函数（注入 llmClient + sessionManager + toolExecutor + onEvent）
- [ ] `run()` 方法：
  - [ ] 加载历史消息（session → ChatMessage 转换，toolResult → user）
  - [ ] 保存用户消息
  - [ ] 两层循环（对齐 pi-agent-core runLoop）
    - [ ] 外层：followUp 处理
    - [ ] 每次实际 LLM 调用前检查 maxLlmCalls
    - [ ] 内层：LLM 流式调用 + 检查 tool_use blocks + 执行工具
  - [ ] 每条消息产生时立即保存到 session
  - [ ] 构建返回结果（累计 usage、总 toolRounds）
- [ ] 无 toolExecutor 时 tool_use 返回错误消息

### Step 3 · index.ts
- [ ] 公共入口

---

## 8. 测试计划

### 8.1 基本对话（mock LLM）

| 测试用例 | 预期行为 |
|---------|---------|
| 简单文本回复 | LLM 返回 text → 保存消息 → 返回 text |
| 多轮对话 | 第二轮 run 能看到第一轮的历史 |
| 空回复 | LLM 返回空内容 → 不报错 |

### 8.2 Tool use loop（mock LLM + mock executor）

| 测试用例 | 预期行为 |
|---------|---------|
| 单次工具调用 | LLM 返回 tool_use → 执行 → 返回结果 → LLM 继续 → end_turn |
| 多次工具调用 | 多轮循环后 end_turn |
| maxLlmCalls 限制 | 达到总调用上限后返回 `max_llm_calls`，保留最后一次 LLM 回复 |
| 无 toolExecutor 时 tool_use | 返回错误消息给 LLM |
| 工具执行失败（isError） | 错误传递给 LLM |

### 8.3 事件回调

| 测试用例 | 预期行为 |
|---------|---------|
| onEvent 接收 run_start / run_end | 正确触发 |
| onEvent 接收 text_delta | 流式文本 |
| onEvent 接收 tool_use / tool_result | 工具事件 |
| onEvent 接收 llm_call | 每轮 LLM 调用触发 |

### 8.4 Session 持久化

| 测试用例 | 预期行为 |
|---------|---------|
| 用户消息保存 | session 中有 user 消息 |
| 助手消息保存 | session 中有 assistant 消息 |
| 工具结果保存 | session 中有 tool_result 消息 |
| 消息顺序正确 | user → assistant(tool_use) → toolResult → assistant(text) |

---

## 9. 后续可优化方向

| 能力 | 触发条件 | 参考 |
|------|---------|------|
| Steering 消息 | Agent 运行中需要注入紧急消息（如用户发新消息） | pi-agent-core `agent.steer()`，每轮 tool 执行后注入 |
| FollowUp 消息 | Agent 循环即将结束时追加排队消息 | pi-agent-core `agent.followUp()`，内层循环退出后检查 |
| 模型 fallback | 主模型失败 | 单独设计 fallback 机制 |
| AbortSignal | 用户取消 | 传递给 llm-client |
| 历史裁剪 | token 超限 | 单独设计 history trimming |
| 压缩策略调优 | 已有压缩流程需要调整预算、阈值或摘要策略 | [core-runner-context-design.md](./core-runner-context-design.md) |
| 真实 tools 模块 | 替代 dummy executor | 工具注册 + 执行框架 |

> 说明：Steering / FollowUp 的详细方案已单独整理到 [steering-followup-design.md](./steering-followup-design.md)，本节只保留高层路线信息。
