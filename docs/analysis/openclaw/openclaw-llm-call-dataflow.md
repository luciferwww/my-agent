# OpenClaw LLM 调用数据流分析

> 分析日期：2026-04-10
> 参考项目：C:\dev\my-agent\openclaw
> 参考文档：https://docs.openclaw.ai/concepts/context, https://docs.openclaw.ai/concepts/memory
> 关联文档：[openclaw-prompt-system-deep-dive.md](./openclaw-prompt-system-deep-dive.md)（system prompt 构建细节）、[openclaw-message-flow.md](./openclaw-message-flow.md)（渠道消息预处理）

---

## 1. 目的

分析 OpenClaw 调用 LLM 时的完整数据组装流程，重点关注：
- system prompt、conversation history、user message、memory、context files 各自如何进入 LLM 调用
- 底层 SDK（pi-agent-core / pi-ai）的消息类型结构
- history 与 user message 的拼接机制

为 my-agent runtime 模块的 user prompt 拼接设计提供参考。

---

## 2. 分层架构总览

```
┌───────────────────────────────────────────────────────────────┐
│  OpenClaw 应用层                                              │
│  src/agents/pi-embedded-runner/run/attempt.ts                 │
│                                                               │
│  职责：                                                       │
│  - 加载/清理/裁剪 session history                              │
│  - 构建 system prompt（调用 buildAgentSystemPrompt）           │
│  - 准备 user prompt 文本（hooks + warnings + images）         │
│  - 组装 tools                                                 │
│  - 写入 agent.state.messages / agent.state.systemPrompt       │
│  - 调用 session.prompt(effectivePrompt)                       │
└────────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  pi-agent-core SDK 层                                         │
│  @mariozechner/pi-agent-core                                  │
│                                                               │
│  Agent.prompt(input)                                          │
│    → 包装为 AgentMessage { role: "user", content, timestamp } │
│    → _runLoop([userMsg])                                      │
│      → 构建 context = { systemPrompt, messages: [...history] }│
│      → runAgentLoop(prompts, context)                         │
│        → context.messages = [...history, ...prompts]  ← 合并  │
│        → runLoop() → streamAssistantResponse()                │
└────────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────┐
│  pi-ai 传输层                                                 │
│  @mariozechner/pi-ai                                          │
│                                                               │
│  streamAssistantResponse():                                   │
│    messages = transformContext(messages)  // 可选变换           │
│    llmMessages = convertToLlm(messages)  // 过滤标准角色       │
│    llmContext = { systemPrompt, messages: llmMessages, tools } │
│    → streamFunction(model, llmContext, options)                │
│    → 发送到具体 LLM API (Anthropic/OpenAI/Google/...)         │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. 消息类型结构

### 3.1 pi-ai 层 — LLM 原生消息类型

定义于 `@mariozechner/pi-ai/dist/types.d.ts`：

```typescript
// 用户消息
interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}

// 助手消息
interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api;               // "anthropic-messages" | "openai-completions" | ...
    provider: Provider;     // "anthropic" | "openai" | ...
    model: string;
    responseId?: string;
    usage: Usage;
    stopReason: StopReason; // "stop" | "length" | "toolUse" | "error" | "aborted"
    errorMessage?: string;
    timestamp: number;
}

// 工具结果
interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    details?: any;
    isError: boolean;
    timestamp: number;
}

// 联合类型
type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

### 3.2 内容块类型

```typescript
interface TextContent     { type: "text";     text: string; }
interface ImageContent    { type: "image";    data: string; mimeType: string; }
interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; }
interface ToolCall        { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; }
```

### 3.3 pi-agent-core 层 — 可扩展消息类型

```typescript
// AgentMessage = 标准 LLM 消息 + 可扩展的自定义消息
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

pi-agent-core 内部使用 `AgentMessage[]`，在发送给 LLM 前通过 `convertToLlm()` 转回 `Message[]`。

### 3.4 LLM 调用上下文

```typescript
// pi-ai 的 Context 接口 — 最终发给 LLM 的结构
interface Context {
    systemPrompt?: string;
    messages: Message[];
    tools?: Tool[];
}
```

---

## 4. History 与 User Message 的拼接机制

### 4.1 数据流

```
OpenClaw attempt.ts                         pi-agent-core
────────────────────                        ──────────────

1. SessionManager.open(sessionFile)
   → 加载磁盘上的 session 文件

2. sanitizeSessionHistory()                 
   → validateReplayTurns()
   → filterHeartbeatPairs()
   → limitHistoryTurns()
   → sanitizeToolUseResultPairing()
   → pruneProcessedHistoryImages()
   → 写入 activeSession.agent.state.messages    ← 这就是 history

3. activeSession.prompt(effectivePrompt)
                                            ↓
                                        Agent.prompt(input):
                                          // 把 input 包装为 AgentMessage
                                          msg = {
                                            role: "user",
                                            content: [{ type: "text", text: input }],
                                            timestamp: Date.now()
                                          }
                                          → _runLoop([msg])

                                        _runLoop(messages):
                                          context = {
                                            systemPrompt: state.systemPrompt,
                                            messages: state.messages.slice()  // history 副本
                                          }
                                          → runAgentLoop(messages, context)

                                        runAgentLoop(prompts, context):
                                          // ★ 核心拼接点
                                          context.messages = [...context.messages, ...prompts]
                                          //                   ^^^^^^^^^^^^^^^^     ^^^^^^^
                                          //                   history              user message(s)
                                          → runLoop(context) → streamAssistantResponse()

                                        streamAssistantResponse():
                                          messages = transformContext?.(messages) ?? messages
                                          llmMessages = convertToLlm(messages)
                                          // convertToLlm 默认实现：只保留 user/assistant/toolResult
                                          llmContext = { systemPrompt, messages: llmMessages, tools }
                                          → streamFunction(model, llmContext, options)  // → LLM API
```

### 4.2 关键代码

**拼接点（`agent-loop.js` 第 42-56 行）**：

```javascript
export async function runAgentLoop(prompts, context, config, ...) {
    const currentContext = {
        ...context,
        messages: [...context.messages, ...prompts],  // history + user message 在此合并
    };
    await runLoop(currentContext, ...);
}
```

**convertToLlm 默认实现（`agent.js` 第 10-12 行）**：

```javascript
function defaultConvertToLlm(messages) {
    return messages.filter((m) =>
        m.role === "user" || m.role === "assistant" || m.role === "toolResult"
    );
}
```

**LLM 调用构建（`agent-loop.js` 第 140-161 行）**：

```javascript
async function streamAssistantResponse(context, config, ...) {
    let messages = context.messages;
    if (config.transformContext) {
        messages = await config.transformContext(messages, signal);
    }
    const llmMessages = await config.convertToLlm(messages);
    const llmContext = {
        systemPrompt: context.systemPrompt,
        messages: llmMessages,
        tools: context.tools,
    };
    const response = await streamFunction(model, llmContext, options);
}
```

### 4.3 实际 messages 数组示例

```typescript
// agent.state.messages（history）+ 新 user message 拼接后：
[
  // ── history ──
  { role: "user",      content: "你好",                                    timestamp: 1712700000 },
  { role: "assistant", content: [{type:"text", text:"你好！有什么可以帮你？"}],  stopReason: "stop", ... },
  { role: "user",      content: "帮我读取 config.ts",                       timestamp: 1712700060 },
  { role: "assistant", content: [{type:"toolCall", id:"tc1", name:"read",
                                   arguments:{path:"config.ts"}}],           stopReason: "toolUse", ... },
  { role: "toolResult", toolCallId: "tc1", toolName: "read",
                        content: [{type:"text", text:"export const config = {...}"}],
                        isError: false, timestamp: 1712700062 },
  { role: "assistant", content: [{type:"text", text:"这个文件包含..."}],      stopReason: "stop", ... },

  // ── 新 user message（由 Agent.prompt() 生成）──
  { role: "user",      content: [{type:"text", text:"用户最新消息"}],         timestamp: 1712700120 },
]
```

---

## 5. System Prompt 的组成

system prompt 由 `buildAgentSystemPrompt()`（`src/agents/system-prompt.ts`）构建，是一个大字符串。

主要构成（按顺序）：

| 顺序 | 内容 | 说明 |
|------|------|------|
| 1 | Identity | `"You are a personal assistant operating inside OpenClaw."` |
| 2 | Tooling | 工具使用通用规则 |
| 3 | Tool Call Style | 调用风格（可被 provider 覆盖） |
| 4 | Execution Bias | 执行偏好 |
| 5 | Safety | 安全约束 |
| 6 | CLI Reference | OpenClaw 命令参考 |
| 7 | Skills | 技能目录（名称+描述，不含技能全文） |
| 8 | **Memory** | 通过插件机制 `buildMemoryPromptSection()` 注入 |
| 9 | Workspace | 工作目录路径 |
| 10 | Docs | 文档链接 |
| 11 | Sandbox | 沙箱信息（如启用） |
| 12 | User Identity | 授权发送者 |
| 13 | Time | 时区信息 |
| 14 | **Project Context (stable)** | context files 内容（见 5.1） |
| 15 | Silent Replies | 静默回复规则 |
| 16 | `── CACHE BOUNDARY ──` | Anthropic prompt cache 分界线 |
| 17 | **Project Context (dynamic)** | `HEARTBEAT.md` 等频繁变化的文件 |
| 18 | Extra System Prompt | 群聊/子代理上下文 |
| 19 | Heartbeat | 心跳配置 |
| 20 | Runtime | 运行时元信息（host、os、model、channel 等） |

> 完整的 25 个 Section 详细分析见 [openclaw-prompt-system-deep-dive.md](./openclaw-prompt-system-deep-dive.md)

### 5.1 Context Files 的注入

Context files（`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`TOOLS.md`、`BOOTSTRAP.md`、`MEMORY.md` 等）直接嵌入 system prompt 的 `# Project Context` 部分。

排序规则定义在 `system-prompt.ts`：

```typescript
const CONTEXT_FILE_ORDER = new Map([
    ["agents.md",   10],
    ["soul.md",     20],
    ["identity.md", 30],
    ["user.md",     40],
    ["tools.md",    50],
    ["bootstrap.md",60],
    ["memory.md",   70],  // MEMORY.md 排在最后
]);
```

稳定文件在 cache boundary 之上，动态文件（如 `heartbeat.md`）在 cache boundary 之下。

---

## 6. Memory 的三条注入路径

### 路径 A：System Prompt 中的 Memory Section（指令层面）

- `system-prompt.ts` 调用 `buildMemorySection()` → `buildMemoryPromptSection()`
- 这是一个插件机制（`src/plugins/memory-state.ts`），由 memory 插件注册 `promptBuilder`
- 注入的是 **memory 使用指引**（告诉模型有 `memory_search`、`memory_get`、`memory_write` 工具可用），而非 memory 内容本身
- 仅在 `full` 模式下注入，`minimal` 模式跳过

### 路径 B：Context Files 中的 MEMORY.md（内容层面）

- `MEMORY.md` 作为 workspace context file 被加载
- 其内容直接嵌入 system prompt 的 `# Project Context` 部分
- 每日笔记 `memory/YYYY-MM-DD.md`（今天和昨天的）同理自动加载
- 这些文件在每个 session 启动时加载

### 路径 C：运行时工具调用（按需检索）

- `memory_search`、`memory_get`、`memory_write` 作为工具注入到 tools 数组
- 模型在对话过程中自主决定何时调用这些工具
- 工具结果以 `{ role: "toolResult" }` 形式出现在 conversation history 中

### 总结

```
Memory 在 LLM 调用中的位置：

system prompt:
  ├── Memory Section (路径A)        → 使用指引："有这些 memory 工具可用"
  └── Project Context (路径B)       → MEMORY.md 文件内容（长期记忆）
                                    → memory/YYYY-MM-DD.md（每日笔记）

messages[]:
  └── toolResult entries (路径C)    → memory_search/memory_get 的查询结果
                                      （存在于 conversation history 中）
```

---

## 7. User Prompt 的构建流程

在 `attempt.ts` 中，user prompt 经过多步处理后才交给 `session.prompt()`：

```
params.prompt（原始用户消息）
  │
  ├─ scrubAnthropicRefusalMagic()          // 清理 Anthropic 特殊标记
  │
  ├─ + ackExecutionFastPathInstruction     // 追加快速执行指令（可选）
  │
  ├─ + planningOnlyRetryInstruction        // 追加计划重试指令（可选）
  │
  ├─ prependBootstrapPromptWarning()       // 前置引导警告（context files 过大时）
  │
  ├─ + hookResult.prependContext           // before_prompt_build hook 注入的前置上下文
  │
  ├─ detectAndLoadPromptImages()           // 检测并加载引用的图片
  │
  └─ activeSession.prompt(effectivePrompt, { images })
     // 提交给 pi-agent-core SDK
```

注意：Hooks 还可以通过 `prependSystemContext` 和 `appendSystemContext` 修改 system prompt，但不修改 user prompt。

---

## 8. 最终发送给 LLM 的完整结构

```typescript
{
    // system prompt — 一个大字符串
    systemPrompt: "You are a personal assistant...\n## Tooling\n...\n## Memory\n...\n# Project Context\n## MEMORY.md\n...",

    // messages — 扁平数组，user/assistant/toolResult 交替排列
    messages: [
        { role: "user",        content: "...",  timestamp: ... },
        { role: "assistant",   content: [...],  stopReason: "stop",    ... },
        { role: "user",        content: "...",  timestamp: ... },
        { role: "assistant",   content: [...],  stopReason: "toolUse", ... },
        { role: "toolResult",  content: [...],  toolName: "memory_search", ... },
        { role: "assistant",   content: [...],  stopReason: "stop",    ... },
        // ...
        { role: "user",        content: [{type:"text", text:"当前用户消息"}], timestamp: ... },
    ],

    // tools — 工具定义数组
    tools: [
        { name: "read",           description: "...", parameters: {...} },
        { name: "write",          description: "...", parameters: {...} },
        { name: "exec",           description: "...", parameters: {...} },
        { name: "memory_search",  description: "...", parameters: {...} },
        { name: "memory_get",     description: "...", parameters: {...} },
        { name: "memory_write",   description: "...", parameters: {...} },
        // ...
    ],
}
```

---

## 9. History 处理管线

Session history 在进入 messages 数组前经过多步清理（`attempt.ts`）：

```
SessionManager.open(sessionFile)           // 从磁盘加载原始 session
  → sanitizeSessionHistory()               // 清理不兼容的消息格式（provider 差异）
  → validateReplayTurns()                  // 验证轮次有效性
  → filterHeartbeatPairs()                 // 过滤心跳消息对
  → limitHistoryTurns()                    // 按配置限制历史轮数
  → sanitizeToolUseResultPairing()         // 修复截断导致的工具调用配对断裂
  → pruneProcessedHistoryImages()          // 裁剪旧轮次的图片块（减少 context 消耗）
  → contextEngine.assemble()               // 上下文引擎优化（可选，可注入 systemPromptAddition）
  → activeSession.agent.state.messages     // 写入 SDK 的 state
```

---

## 10. 对 my-agent 设计的启示

### 10.1 关键设计要点

| 要点 | OpenClaw 做法 | 启示 |
|------|-------------|------|
| history + user message 拼接 | 由底层 SDK 在 `runAgentLoop()` 中通过数组展开合并，应用层不手动拼接 | 我们的 AgentRunner 也应在 SDK 层处理，RuntimeApp 不应直接操作 messages 数组 |
| Memory 注入 | 不放在 user message 中；指引在 system prompt，内容通过 context files 和 tool results | 我们的 UserPromptBuilder 不需要关心 memory 注入 |
| Context files | 直接嵌入 system prompt 末尾，不是单独的 message | 与我们 prompt-builder-design.md 的设计一致 |
| User prompt 处理 | 多步预处理后仍是纯文本，由 SDK 包装为 `{ role: "user" }` | 我们的 UserPromptBuilder.build() 只需输出文本 + attachments |
| convertToLlm | 默认只过滤 role，不做格式转换 | 简单可靠，我们可以直接采用相同策略 |

### 10.2 与现有设计文档的对应

| OpenClaw 组件 | 我们的对应设计 | 设计文档 |
|-------------|-------------|---------|
| `buildAgentSystemPrompt()` | `SystemPromptBuilder.build()` | [prompt-builder-design.md](../../architecture/prompt-builder-design.md) |
| `attempt.ts` 中的 user prompt 预处理 | `UserPromptBuilder.build()` + ContextHooks | [prompt-builder-design.md](../../architecture/prompt-builder-design.md) |
| `pi-agent-core` Agent + agentLoop | `AgentRunner` | [agent-runner-design.md](../../architecture/agent-runner-design.md) |
| `SessionManager` | `SessionManager` | [session-design.md](../../architecture/session-design.md) |
| `memory-state.ts` 插件机制 | `MemoryManager` | [memory-design.md](../../architecture/memory-design.md) |
| `attempt.ts` 整体编排 | `RuntimeApp.runTurn()` | [runtime-app-assembly-design.md](../../architecture/runtime-app-assembly-design.md) |

### 10.3 UserPromptBuilder 设计确认

基于本次分析，确认 `UserPromptBuilder` 的职责边界：

- **应该做**：hook 注入前置上下文 + 拼接用户原始文本 + 分离 attachments
- **不应该做**：注入 memory 内容、管理 conversation history、包装为 `{ role: "user" }` 消息对象

这与 [prompt-builder-design.md](../../architecture/prompt-builder-design.md) 第 6 节的设计一致。
