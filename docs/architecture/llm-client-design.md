# LLM Client 模块设计文档

> 创建日期：2026-04-02  
> 参考：相关 LLM 调用与执行链路分析

---

## 1. 概述

LLM Client 模块负责调用 LLM API，是执行引擎和 LLM 之间的桥梁。

**职责**：
- 提供统一的 `LLMClient` 抽象接口
- 实现 Anthropic SDK 版本（`AnthropicClient`）
- 流式调用（`chatStream`）和便捷非流式调用（`chat`）
- 支持自定义 `baseURL`（对接 LiteLLM Proxy、MAI-LLMProxy 等代理）

**不属于 LLM Client 的职责**：
- Session 管理（session 模块）
- Prompt 构建（prompt-builder 模块）
- 工具执行（未来的 tools 模块）
- Agent 循环（未来的 agent-runner 模块）
- 配置加载与解析（应由 runtime 或调用方完成）

### 配置边界

LLM Client 负责“如何调用模型 API”，不负责“从哪里读取全局配置”。

因此，LLM Client 原则上不应直接访问 config：

- 不应直接调用 `loadConfig()` 或 `resolveAgentConfig()`；
- 不应自行读取 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等环境变量并据此改变行为；
- 应通过构造参数显式接收 `apiKey`、`baseURL` 等最小配置子集。

这条边界的目的，是让 LLM Client 保持为可测试、可替换的底层适配器，而不是把它变成运行时入口的一部分。

---

## 2. 设计取舍

当前 `llm-client` 的设计取舍如下：

- 用 `LLMClient` 接口隔离具体 provider，实现先从 `AnthropicClient` 起步；
- 把流式调用作为底层原语，`chat()` 只是对 `chatStream()` 的便捷包装；
- 保持消息类型、工具类型在本模块内自洽，不依赖 session 或 prompt-builder 的内部类型；
- 显式支持 `baseURL`，方便对接代理或兼容端点；
- 当前不追求多 provider、多 fallback、多运行模式，先把最小可用调用链做稳定。

---

## 3. 目录结构

```
src/
└── llm-client/
    ├── index.ts              # 公共入口
    ├── types.ts              # LLMClient 接口 + ChatMessage + StreamEvent 等类型
    └── AnthropicClient.ts    # Anthropic SDK 实现
```

---

## 4. 类型系统

```typescript
// llm-client/types.ts

// ── 消息类型（独立于 session 模块，对齐 Anthropic API） ─────

export type ChatRole = 'user' | 'assistant';

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentBlock[];
}

// ── 工具定义（独立于 prompt-builder 模块） ──────────────────

export interface ChatToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;  // JSON Schema
}

// ── 调用参数 ────────────────────────────────────────────────

export interface ChatParams {
  model: string;                      // 如 'claude-sonnet-4-6'
  system?: string;                    // system prompt
  messages: ChatMessage[];            // 对话历史
  tools?: ChatToolDefinition[];       // 可用工具
  maxTokens?: number;                 // 默认 4096
  signal?: AbortSignal;               // 取消信号
}

// ── 流式事件 ────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_end'; stopReason: string; usage: TokenUsage }
  | { type: 'error'; error: Error };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ── 非流式响应 ──────────────────────────────────────────────

export interface ChatResponse {
  content: ChatContentBlock[];        // 助手回复内容
  stopReason: string;                 // 'end_turn' | 'tool_use' | 'max_tokens'
  usage: TokenUsage;
}

// ── LLMClient 抽象接口 ─────────────────────────────────────

export interface LLMClient {
  /**
   * 流式调用 LLM。
   * 返回 AsyncIterable，逐个 yield StreamEvent。
   */
  chatStream(params: ChatParams): AsyncIterable<StreamEvent>;

  /**
   * 非流式调用 LLM（便捷方法）。
   * 内部调用 chatStream 收集完整响应后返回。
   */
  chat(params: ChatParams): Promise<ChatResponse>;
}
```

---

## 5. AnthropicClient 实现

```typescript
// llm-client/AnthropicClient.ts

import Anthropic from '@anthropic-ai/sdk';

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;     // 支持 LiteLLM Proxy / MAI-LLMProxy 等
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
    // 调用 Anthropic SDK 流式 API
    // 将 Anthropic 的事件格式转换为我们的 StreamEvent
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    // 调用 chatStream，收集所有事件，拼装为 ChatResponse
    const contentBlocks: ChatContentBlock[] = [];
    let stopReason = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of this.chatStream(params)) {
      switch (event.type) {
        case 'text_delta':
          // 累积文本
          break;
        case 'tool_use':
          contentBlocks.push(event);
          break;
        case 'message_end':
          stopReason = event.stopReason;
          usage = event.usage;
          break;
        case 'error':
          throw event.error;
      }
    }

    return { content: contentBlocks, stopReason, usage };
  }
}
```

---

## 6. 使用示例

### 基本调用

```typescript
import { AnthropicClient } from './llm-client';

const client = new AnthropicClient({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// 非流式
const response = await client.chat({
  model: 'claude-sonnet-4-6',
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello' }],
  maxTokens: 1024,
});
console.log(response.content);
```

### 流式调用

```typescript
for await (const event of client.chatStream({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.text);
  }
}
```

### 对接 LiteLLM Proxy

```typescript
const client = new AnthropicClient({
  apiKey: 'your-litellm-key',
  baseURL: 'http://localhost:4000',
});
```

> **NOTE**: 部分代理（如 LLMProxy）可能不返回完整的 usage 信息，例如 `inputTokens` 返回 0。这是代理的行为，不影响功能。

### 与其他模块配合（执行引擎负责转换）

```typescript
// 执行引擎中（将来实现）
const systemPrompt = new SystemPromptBuilder().build({ tools, contextFiles });
const userPrompt = await new UserPromptBuilder().build({ text: '...' });

// session 的 MessageRecord → llm-client 的 ChatMessage（执行引擎负责转换）
const history = session.getMessages('main');
const chatMessages: ChatMessage[] = history.map(m => m.message);

const response = await client.chat({
  model: 'claude-sonnet-4-6',
  system: systemPrompt,
  messages: [...chatMessages, { role: 'user', content: userPrompt.text }],
});
```

---

## 7. 实施步骤

### Step 1 · types.ts
- [ ] ChatMessage / ChatContentBlock / ChatRole
- [ ] ChatToolDefinition
- [ ] ChatParams
- [ ] StreamEvent / TokenUsage
- [ ] ChatResponse
- [ ] LLMClient 接口

### Step 2 · AnthropicClient.ts
- [ ] 构造函数（apiKey + baseURL）
- [ ] `chatStream()` — Anthropic SDK 流式调用 + 事件转换
- [ ] `chat()` — 内部调用 chatStream 收集完整响应

### Step 3 · index.ts
- [ ] 公共入口

---

## 8. 测试计划

### 8.1 types（编译检查）

| 测试用例 | 预期行为 |
|---------|---------|
| ChatMessage 接受 string content | 编译通过 |
| ChatMessage 接受 ContentBlock[] content | 编译通过 |
| LLMClient 接口可被实现 | 编译通过 |

### 8.2 AnthropicClient

| 测试用例 | 预期行为 |
|---------|---------|
| 构造函数接受 apiKey | 创建 Anthropic 实例 |
| 构造函数接受 baseURL | 传递给 Anthropic SDK |
| chat() 返回 ChatResponse | 包含 content / stopReason / usage |
| chatStream() 产出 message_start | 第一个事件 |
| chatStream() 产出 text_delta | 文本片段 |
| chatStream() 产出 message_end | 包含 stopReason + usage |
| chatStream() 产出 error | 错误时 yield error 事件 |
| chat() 内部收集流式结果 | 最终返回完整响应 |
| signal 取消 | 流式中断，抛出错误 |

> 注意：真实 API 调用的测试需要 API Key，可用 mock 或集成测试环境。

---

## 9. 后续可优化方向

| 能力 | 触发条件 | 参考 |
|------|---------|------|
| OpenAI 实现 | 需要支持 GPT 系列模型 | 新增 `OpenAIClient` 类 |
| 重试机制 | API 偶发失败 | Anthropic SDK 内置重试，或自行包装 |
| 模型 Fallback | 主模型失败切换备用 | 单独设计 fallback 机制 |
| 速率限制 | 高并发场景 | 令牌桶或信号量 |
| 缓存 | 相同请求不重复调用 | 按 messages hash 缓存响应 |
