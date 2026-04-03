# OpenClaw Agent Runner 分析

> 分析日期：2026-04-02  
> 参考项目：C:\dev\my-agent\openclaw

---

## 1. 核心发现：Agent 循环在哪一层

OpenClaw 的 Agent 执行分两层：

- **attempt.ts**（应用层）：输入准备、session 初始化、stream 包装、结果收集
- **pi-agent-core**（库层）：Agent 循环（tool use loop）在这里

```
attempt.ts
  ├─ 准备输入（contextFiles、system prompt、user prompt、图像）
  ├─ 初始化 session（加载历史、裁剪、验证）
  ├─ 配置 streamFn（多层包装）
  │
  ├─ session.prompt(effectivePrompt)  ← 一行调用
  │   └─ pi-agent-core 内部循环：
  │       while (has work) {
  │         LLM 调用 → 解析响应 → tool_use? → 执行工具 → 继续
  │       }
  │
  └─ 收集结果、持久化、返回
```

**关键点**：attempt.ts 不自己写 tool use loop，而是通过 `session.prompt()` 把控制权交给 pi-agent-core，后者内部完成整个循环。

---

## 2. 一次完整调用的三阶段

### Phase 1：输入准备

```
1. contextFiles 加载
   └─ resolveBootstrapContextForRun()

2. system prompt 构建
   └─ buildEmbeddedSystemPrompt({ contextFiles, tools, skills, ... })

3. session 初始化
   ├─ SessionManager.open(sessionFile)  ← 加载 JSONL 历史
   ├─ sanitizeSessionHistory()          ← 修复孤立 tool_result 等
   └─ limitHistoryTurns()               ← 裁剪历史轮次

4. user prompt 构建
   ├─ prependBootstrapPromptWarning()
   ├─ hookResult.prependContext         ← 插件注入
   └─ effectivePrompt

5. 图像处理
   └─ detectAndLoadPromptImages()

6. system prompt 应用
   └─ applySystemPromptOverrideToSession()
```

### Phase 2：LLM 调用 + Agent 循环

```
session.prompt(effectivePrompt, { images })
  │
  ▼
pi-agent-core runLoop()（两层嵌套循环）:
  ┌──────────────────────────────────────────────────────┐
  │ 外层 while (true):                                   │
  │   │                                                  │
  │   │  内层 while (hasMoreToolCalls || pendingMsgs):   │
  │   │    │                                             │
  │   │    │  1. convertToLlm(context.messages)          │
  │   │    │     └─ AgentMessage[] → LLM Message[]       │
  │   │    │                                             │
  │   │    │  2. streamFn(model, llmContext, options)     │
  │   │    │     └─ 调用 LLM API（流式）                 │
  │   │    │     └─ assistant 消息 push 到 context        │
  │   │    │        （流式开始时 push，过程中替换末尾）    │
  │   │    │                                             │
  │   │    │  3. 退出判断：                               │
  │   │    │     ├─ stopReason === "error"/"aborted"     │
  │   │    │     │  └─ emit(agent_end) → return 退出函数 │
  │   │    │     │                                       │
  │   │    │     ├─ content 中有 toolCall blocks?         │
  │   │    │     │  ├─ YES → hasMoreToolCalls = true     │
  │   │    │     │  └─ NO  → hasMoreToolCalls = false    │
  │   │    │     │           └─ 内层循环条件不满足 → 退出 │
  │   │    │                                             │
  │   │    │  4. 如果 hasMoreToolCalls：                  │
  │   │    │     ├─ beforeToolCall hook（可阻止）         │
  │   │    │     ├─ 执行工具（sequential 或 parallel）    │
  │   │    │     ├─ afterToolCall hook（可修改结果）      │
  │   │    │     ├─ 构造 ToolResultMessage               │
  │   │    │     └─ context.messages.push(toolResult)    │
  │   │    │        └─ 直接 push，下轮自然可见            │
  │   │                                                  │
  │   │  内层循环退出（无更多 tool calls）                 │
  │   │                                                  │
  │   ├─ 检查 followUpMessages                           │
  │   │  ├─ 有 → pendingMsgs = followUp, continue       │
  │   │  └─ 无 → break 退出外层循环                      │
  │                                                      │
  └──────────────────────────────────────────────────────┘
  │
  emit({ type: "agent_end" })
```

**关键点**：
- 退出条件基于 content 中是否有 `toolCall` blocks，不是基于 `stopReason` 字符串
- `context.messages` 是可变数组，assistant 和 toolResult 直接 push，无需手动拼接
- 没有 `maxToolRounds` 限制，完全依赖 LLM 的输出决定是否继续
- assistant 消息在流式开始时就 push 到 context，过程中不断替换末尾元素

### Phase 3：输出

```
1. 收集最终消息快照（messagesSnapshot）
2. 提取 assistantTexts、toolMetas
3. 等待 compaction 完成（如果有）
4. 返回结果：
   {
     messagesSnapshot,
     assistantTexts,
     toolMetas,
     lastAssistant,
     attemptUsage,
     compactionCount,
     aborted,
     timedOut,
   }
```

---

## 3. Agent 事件类型

pi-agent-core 发出的事件（OpenClaw 通过 `subscribeEmbeddedPiSession` 订阅）：

| 事件 | 说明 |
|------|------|
| `agent_start` | Agent 循环开始 |
| `turn_start` | 单轮开始（一次 LLM 调用） |
| `message_start` | 消息开始 |
| `message_update` | 流式文本片段 |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_update` | 工具执行进度 |
| `tool_execution_end` | 工具执行完成 |
| `turn_end` | 单轮结束（含工具结果） |
| `agent_end` | Agent 循环结束 |

---

## 4. 工具循环退出条件

| stop_reason | 行为 |
|-------------|------|
| `end_turn` | 正常结束，退出循环 |
| `stop` | 正常结束，退出循环 |
| `tool_use` | 执行工具，继续循环 |
| `max_tokens` | 可能继续（取决于配置） |
| `error` | 错误退出 |
| `aborted` | 用户中止 |

---

## 5. 循环机制详解（来自 pi-agent-core 源码分析）

**源文件**：`node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` → `runLoop()`

### 5.1 两层嵌套循环

```javascript
async function runLoop(currentContext, newMessages, config, signal, emit, streamFn) {
    let firstTurn = true;
    let pendingMessages = (await config.getSteeringMessages?.()) || [];
    
    // 外层循环：处理 followUp 消息
    while (true) {
        let hasMoreToolCalls = true;
        
        // 内层循环：处理 tool calls + steering 消息
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            // 调用 LLM
            const message = await streamAssistantResponse(...);
            
            // 退出条件 1：错误或中止 → 直接退出整个函数
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                await emit({ type: "agent_end" });
                return;
            }
            
            // 退出条件 2：没有 tool calls → hasMoreToolCalls = false → 内层循环退出
            const toolCalls = message.content.filter(c => c.type === "toolCall");
            hasMoreToolCalls = toolCalls.length > 0;
            
            if (hasMoreToolCalls) {
                // 执行工具
                const toolResults = await executeToolCalls(...);
                for (const result of toolResults) {
                    currentContext.messages.push(result);  // ← 直接 push 到 context
                }
            }
        }
        
        // 检查 followUp 消息
        const followUpMessages = await config.getFollowUpMessages?.();
        if (followUpMessages.length > 0) {
            pendingMessages = followUpMessages;
            continue;  // 继续外层循环
        }
        
        break;  // 没有 followUp → 退出
    }
    await emit({ type: "agent_end" });
}
```

### 5.2 关键发现

**没有 maxToolRounds 限制**：pi-agent-core 不限制工具调用轮数，完全依赖 LLM 的 `stopReason` 来退出循环。

**退出条件判断顺序**：
1. `stopReason === "error"` 或 `"aborted"` → 立即退出整个函数
2. `message.content` 中没有 `toolCall` blocks → `hasMoreToolCalls = false` → 内层循环条件不满足 → 退出
3. 退出内层循环后，检查 `followUpMessages` → 没有 → break 退出外层

**不是通过 stopReason === "end_turn" 判断**：实际上是通过检查 content 中有没有 `toolCall` blocks 来决定是否继续。即使 stopReason 是其他值，只要没有 toolCall 就退出。

### 5.3 Steering 和 FollowUp 机制

循环中有三种消息来源，这解释了为什么是两层嵌套循环：

#### Steering 消息
- **用途**：Agent 正在运行时，外部（如用户）插入的紧急消息
- **注入时机**：每轮 tool 执行完毕后、下一次 LLM 调用之前
- **调用方式**：`agent.steer(message)`
- **场景**：用户在 Agent 执行工具的过程中发了新消息，比如"停下，换个方向"

```
LLM 调用 → assistant 回复 → 执行工具 →
  检查 steering 队列 → 有消息 → 注入到 context → 继续 LLM 调用
```

#### FollowUp 消息
- **用途**：Agent 循环即将结束时（没有更多 tool calls），外部追加的消息
- **注入时机**：内层循环退出后、外层循环 break 之前
- **调用方式**：`agent.followUp(message)`
- **场景**：Agent 说完了，但外部有排队的消息需要继续处理

```
内层循环退出（没有 tool calls）→
  检查 followUp 队列 → 有消息 → 设为 pending → 继续外层循环
```

#### 出队模式
```typescript
steeringMode: "one-at-a-time" | "all"   // 每次取一条还是全部
followUpMode: "one-at-a-time" | "all"
```

#### 两层循环的对应关系

```
外层 while (true):              ← 处理 followUp
  内层 while (hasMoreToolCalls   ← 处理 tool calls
            || pendingMsgs):     ← 处理 steering（和 followUp 转入的 pending）

  内层退出 → 检查 followUp → 有 → 转入 pending → 继续外层
  内层退出 → 检查 followUp → 无 → break 退出
```

> 对我们来说，steering 和 followUp 是**高级特性**，当前不需要实现。但它们解释了为什么 pi-agent-core 用两层嵌套循环而不是一个简单的 while。

### 5.4 消息拼接方式

`context.messages` 是一个**可变数组**，不是每轮重新构建：

```
初始: context.messages = [...历史, user消息]
  │
  ▼ 第一轮 LLM 调用
  │ streamAssistantResponse 内部：
  │   context.messages.push(assistantMessage)    ← 直接 push
  │ 现在: [...历史, user, assistant]
  │
  ▼ 如果有 tool calls
  │ executeToolCalls 返回后：
  │   context.messages.push(toolResult)          ← 直接 push
  │ 现在: [...历史, user, assistant, toolResult]
  │
  ▼ 第二轮 LLM 调用
  │ context 已经包含所有历史，自动传给 LLM
  │ streamAssistantResponse 内部：
  │   context.messages.push(assistantMessage2)   ← 直接 push
  │ 现在: [...历史, user, assistant, toolResult, assistant2]
```

**无需手动拼接**——所有消息都 push 到同一个数组，下一轮自然能看到。

### 5.5 流式响应处理（streamAssistantResponse）

```javascript
async function streamAssistantResponse(context, config, signal, emit, streamFn) {
    // 1. 转换消息格式：AgentMessage[] → LLM Message[]
    const llmMessages = await config.convertToLlm(messages);
    
    // 2. 构建 LLM context
    const llmContext = { systemPrompt, messages: llmMessages, tools };
    
    // 3. 调用 LLM（流式）
    const response = await streamFunction(config.model, llmContext, options);
    
    // 4. 处理流式事件
    for await (const event of response) {
        switch (event.type) {
            case "start":
                // assistant 消息开始 → push 到 context.messages
                context.messages.push(partialMessage);
                break;
            case "text_delta":
            case "toolcall_delta":
                // 流式更新 → 替换 context.messages 末尾
                context.messages[context.messages.length - 1] = event.partial;
                break;
            case "done":
            case "error":
                // 流式结束 → 替换为最终版本
                context.messages[context.messages.length - 1] = finalMessage;
                return finalMessage;
        }
    }
}
```

**关键**：assistant 消息在流式开始时就 push 到 context，流式过程中不断替换末尾元素，流式结束时替换为最终版本。不是等流式完成后才 push。

---

## 6. 对我们设计的启示

### 我们不需要的
- streamFn 多层包装（7+ 层）— 我们只有一个 provider
- Compaction 处理 — 留给将来
- steering/followUp 消息注入 — 高级特性
- 多种 transcript policy — 只有 Anthropic

### 我们需要的核心流程

```
agent-runner:
  1. 加载 contextFiles（workspace 模块）
  2. 构建 system prompt（prompt-builder 模块）
  3. 构建 user prompt（prompt-builder 模块）
  4. 加载历史消息（session 模块）
  5. 调用 LLM（llm-client 模块）
  6. 如果 tool_use → 执行工具 → 把结果加入消息 → 回到步骤 5
  7. 保存消息到 session（session 模块）
  8. 返回结果
```

### 关键设计决策

| 决策 | OpenClaw | 我们的选择 |
|------|---------|-----------|
| Tool loop 在哪层 | pi-agent-core（库） | agent-runner 自己实现（简单循环） |
| 事件机制 | 订阅模式（subscribe） | 直接回调或 AsyncIterable |
| Session 持久化时机 | 事件处理中自动进行 | 每轮结束后显式调用 |
| streamFn 包装 | 7+ 层包装链 | 不需要包装，直接调用 llm-client |

---

## 7. 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/agents/pi-embedded-runner/run/attempt.ts` | 核心执行逻辑（2800+ 行） |
| `src/agents/pi-embedded-runner/run.ts` | 入口（并发、认证、重试） |
| `src/agents/agent-command.ts` | 总调度器 |
| `src/agents/pi-embedded-subscribe.ts` | 事件订阅 |
| `src/agents/pi-embedded-subscribe.handlers.ts` | 事件处理 |
| `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` | Agent 循环（tool use loop） |
| `node_modules/@mariozechner/pi-agent-core/dist/agent.js` | Agent 类（prompt 方法） |
