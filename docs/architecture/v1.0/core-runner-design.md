# Agent Runner 模块设计文档

> 版本：v1.0
> 创建日期：2026-05-18
> 关联：
> - [runtime-design.md](./runtime-design.md)
> - [adapters-channel-design.md](./adapters-channel-design.md)
> - [core-runner-message-flow.md](./core-runner-message-flow.md)
> - [Current Runner](../current/core_runner.md)
> - [Tool/Hook Module Spec](../tool-hook-module-spec.md)
> - [Current Provider Adapter](../current/adapter_llm.md)

---

## 1. 概述

Agent Runner 是执行引擎，串联 `adapters/llm`、`core/session`、`core/tools` 与上下文管理模块，完成一次完整的对话循环。

### 1.1 职责

- 编排 LLM 调用 → tool 执行 → tool 结果回传 → LLM 继续的执行循环；
- 上下文预算管理：决定何时裁剪 / 何时聚合裁剪 / 何时触发摘要压缩；
- 压缩编排与外层重试：捕获 `ContextOverflowError`，调用 `compactMessages` 写入 session 后再次尝试 run；
- 消息持久化：用户消息、assistant 回复、tool result 在产生时立即写入 session；
- 触发 hook（`before_tool_call` / `after_tool_call` / `before_compaction` / `after_compaction`）与 event（`run_start` / `text_delta` / `tool_use` / `tool_result` / `llm_call` / `run_end` / `error` / `compaction_*` / `tool_result_pruned`）；
- 在 turn 内 tool 迭代之间通过 `getSteeringMessages` reader 拉取 steering 消息（reader 实现由 runtime 提供）。

### 1.2 不属于本模块的职责

- 配置加载与解析——由 runtime 层完成后显式传入；
- 工具的注册和定义——属于 `core/tools`；
- system prompt / user prompt 的构建——属于 `core/prompt`；
- channel I/O 与 approval 路由——属于 `adapters/channel` + `runtime`；
- 入站消息的队列调度、per-session 串行——属于 `runtime`；
- 跨 turn 的会话生命周期——属于 `runtime` + `core/session`。

### 1.3 配置边界

Agent Runner 原则上不直接访问 config。具体来说：

- 不调用 `loadConfig()` 或 `resolveAgentConfig()`；
- 不通过 `process.env` 自行读取关键运行配置；
- 不依赖完整 `AgentDefaults` 作为常规输入。

Runtime 层先完成配置解析，再把 Agent Runner 真正需要的最小输入显式传入：

- `model`
- `systemPrompt`
- `tools`
- `maxTokens`
- `maxLlmCalls`
- `compaction`
- `contextWindowTokens`

这样 Agent Runner 才能保持为一个纯执行引擎，而不是半个应用入口。

### 1.4 与其他模块的关系

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AgentRunner                                    │
│                                                                          │
│  run()                                                                   │
│   ├─ 外层压缩重试循环                                                     │
│   │   ├─ runAttempt()                                                    │
│   │   │   ├─ sanitizeSessionTail（清洗孤立 trailing user）               │
│   │   │   ├─ loadHistory (感知 compaction record)                        │
│   │   │   ├─ Layer 1: pruneToolResults                                   │
│   │   │   ├─ Layer 2: checkContextBudget → 路由决定                      │
│   │   │   │    ├─ 'fits' → 继续                                          │
│   │   │   │    ├─ 'truncate_tool_results_only' → Layer 1.5 聚合裁剪      │
│   │   │   │    └─ 'compact' → 抛 ContextOverflowError                    │
│   │   │   ├─ appendMessage(user) + push 到 messages（preflight 之后）    │
│   │   │   ├─ 执行循环（LLM 调用 + tool use）                              │
│   │   │   │    ├─ callLLMStream → emit events                            │
│   │   │   │    ├─ before_tool_call hook → executeTool → after_tool_call  │
│   │   │   │    ├─ 90% 阈值检查                                            │
│   │   │   │    └─ getSteeringMessages reader（每轮 tool 后）              │
│   │   │   └─ return RunResult                                            │
│   │   └─ catch ContextOverflowError                                      │
│   │       └─ compactHistory（开头亦 sanitizeSessionTail） → retry        │
│   └─ emit run_end                                                        │
│                                                                          │
│  外部依赖：                                                              │
│   - LLMClient.chatStream                                                 │
│   - SessionManager: getMessages / appendMessage / appendCompactionRecord │
│   - ToolExecutor                                                         │
│   - context/{ pruneToolResults, checkContextBudget, compactMessages,     │
│              estimatePromptTokens, isContextOverflowError }              │
│   - hooks/{ runBefore/After ToolCall / Compaction }                      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 目录结构

```
src/core/runner/
├── index.ts                       # 公共导出
├── types.ts                       # AgentRunnerConfig / RunParams / RunResult / AgentEvent / PendingMessageReader
├── AgentRunner.ts                 # 主类
├── errors.ts                      # ContextOverflowError / isContextOverflowError
├── test-helpers.ts                # makeRunParams() 等测试辅助
├── hooks/
│   ├── index.ts                   # runBefore/After ToolCall / Compaction
│   ├── runner.ts                  # hook 执行器（priority 排序、Interceptor / Observer 区分）
│   └── types.ts                   # BeforeToolCallHook / AfterToolCallHook / Before/AfterCompactionHook
└── context/
    ├── token-estimation.ts        # estimatePromptTokens
    ├── tool-result-pruning.ts     # pruneToolResults (Layer 1) / pruneToolResultsAggregate (Layer 1.5)
    ├── context-budget.ts          # checkContextBudget (Layer 2)
    └── compaction.ts              # compactMessages (Layer 3)
```

`hooks/` 与 `context/` 是 Agent Runner 的子模块；当前行为见 [Current Runner](../current/core_runner.md)，Hook contract 见 [Tool/Hook Module Spec](../tool-hook-module-spec.md)，本文只描述 AgentRunner 主类如何编排它们。

---

## 3. 类型系统

### 3.1 AgentRunnerConfig

```typescript
export interface AgentRunnerConfig {
  llmClient: LLMClient;
  sessionManager: SessionManager;
  /** 工具执行回调；不提供则 tool_use 时返回错误 */
  toolExecutor?: ToolExecutor;
  /**
   * 运行时事件回调（统一入口）。
   * RuntimeApp 在 bootstrap 时注入 fanout 闭包，由它转发事件到所有已注册 channel
   * 与可选的 RuntimeAppOptions.onAgentEvent 观察者。
   * 库消费者直接使用 AgentRunner 时也可在此注入自己的 handler。
   */
  onEvent?: (event: AgentEvent) => void;
}
```

### 3.2 RunParams

```typescript
export interface RunParams {
  /** Session key */
  sessionKey: string;
  /** 用户消息文本 */
  message: string;
  /** 模型名称 */
  model: string;
  /** System prompt（由调用方通过 core/prompt 构建） */
  systemPrompt: string;
  /**
   * 本次 turn 的唯一 id；由 RuntimeApp 生成并传入。
   * AgentRunner 用于：
   *   - emit 时自动注入到每个 AgentEvent
   *   - 触发 before/after_tool_call / before/after_compaction hook 时注入 payload
   * 直接调用 AgentRunner 的库消费者需自行生成 UUID。
   */
  turnId: string;
  /** 工具定义（传给 LLM） */
  tools?: ToolDefinition[];
  /** 最大 token 数，默认 4096 */
  maxTokens?: number;
  /** 单次 run 允许的最大 LLM 调用次数，默认 12 */
  maxLlmCalls?: number;
  /** steering 消息读取回调（runner 在每轮 tool 执行后调用） */
  getSteeringMessages?: PendingMessageReader;
  /** 压缩配置（由 RuntimeApp 传入） */
  compaction?: CompactionConfig;
  /** 模型上下文窗口大小（由 RuntimeApp 从 config.llm.contextWindowTokens 传入），默认 200,000 */
  contextWindowTokens?: number;
}

export type PendingMessageReader = () => ChatMessage[] | Promise<ChatMessage[]>;
```

设计要点：

- **`turnId` 是必填字段**——AgentRunner 内部 emit / hook payload 都依赖它；RuntimeApp 层对调用方是可选（不传则自动生成），到达 AgentRunner 时已保证存在；
- **`getSteeringMessages` 是 reader 抽象**——AgentRunner 在每轮 tool 执行后调用，runtime 决定 reader 的实现（详见 [message-flow](./core-runner-message-flow.md)）；reader 未提供时 runner 视为无 steering 输入。

### 3.3 RunResult

```typescript
export interface RunResult {
  /** 助手最终回复的文本 */
  text: string;
  /** 助手回复的完整 content blocks */
  content: ChatContentBlock[];
  /** stop reason: 'end_turn' | 'max_llm_calls' | 'error' | 'aborted' | ... */
  stopReason: string;
  /** 累计 token 用量（所有 LLM 调用的总和） */
  usage: TokenUsage;
  /** tool use 循环总轮数（所有外层迭代的总和） */
  toolRounds: number;
  /** 本次运行是否触发了压缩 */
  compacted?: boolean;
}
```

注：详细的压缩统计通过 `compaction_end` 事件提供；是否在 `RunResult` 暴露 `compactionStats` 字段待明确消费方后再讨论。

### 3.4 AgentEvent

每个 variant 都自带 `sessionKey` 与 `turnId`——AgentRunner 内部 emit 时从 `currentParams` 自动注入，调用方不必手填（详见 §10）。

```typescript
export type AgentEvent =
  | { type: 'run_start'; sessionKey: string; turnId: string }
  | { type: 'text_delta'; sessionKey: string; turnId: string; text: string }
  | { type: 'tool_use'; sessionKey: string; turnId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; sessionKey: string; turnId: string; name: string; result: ToolResult }
  | { type: 'llm_call'; sessionKey: string; turnId: string; round: number }
  | { type: 'run_end'; sessionKey: string; turnId: string; result: RunResult }
  | { type: 'error'; sessionKey: string; turnId: string; error: Error }
  | {
      type: 'tool_result_pruned';
      sessionKey: string;
      turnId: string;
      toolUseId: string;
      originalChars: number;
      prunedChars: number;
    }
  | {
      type: 'compaction_start';
      sessionKey: string;
      turnId: string;
      trigger: 'preemptive' | 'overflow' | 'manual';
      estimatedTokens: number;
    }
  | {
      type: 'compaction_end';
      sessionKey: string;
      turnId: string;
      tokensBefore: number;
      tokensAfter: number;
      droppedMessages: number;
    }
  | {
      /**
       * runAttempt / compactHistory 入口处检测到当前分支末尾是孤立的 trailing
       * user message，已通过 branch(parentId) 回退 leafId。仅修改内存，不写
       * JSONL；被丢弃的 entry 仍保留在文件中可审计。
       */
      type: 'session_tail_sanitized';
      sessionKey: string;
      turnId: string;
      discardedEntryId: string;
      discardedRole: 'user';
    };
```

设计要点：

- **不引入公共基类型抽象**：每个 variant 自描述 `sessionKey` / `turnId`，外部看到的就是平铺的 discriminated union；
- **`compaction_start.estimatedTokens`**：开始时只有估算值；准确的"压缩前 token 数"在 `compaction_end.tokensBefore` 给出；
- **`error` 既 emit 又 throw**：让 channel / 库消费者自由选择呈现路径（详见 [channel-design §6.2](./adapters-channel-design.md)）。

---

## 4. 执行流程总览

### 4.1 入口 run()

```typescript
async run(params: RunParams): Promise<RunResult> {
  const contextWindowTokens = params.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const compaction = params.compaction ?? DEFAULT_COMPACTION_CONFIG;

  this.currentParams = params;
  try {
    this.emit({ type: 'run_start' });

    // 用户消息不在 run() 入口落盘——已下沉到 runAttempt() 内部，
    // 在 Layer 2 preflight 通过之后才写入。这样：
    //   - preemptive 压缩抛出时不会留下污染当前历史的孤立 user
    //   - 压缩重试不会重复 append user message
    // 详见 §9.2 sanitizeSessionTail。

    let compactionAttempts = 0;
    let compacted = false;

    // 外层压缩重试循环
    while (true) {
      try {
        const result = await this.runAttempt(params, contextWindowTokens, compaction);
        const finalResult: RunResult = { ...result, compacted };
        this.emit({ type: 'run_end', result: finalResult });
        return finalResult;
      } catch (err) {
        if (err instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
          await this.compactHistory(params, compaction, err.trigger);
          compacted = true;
          compactionAttempts++;
          continue;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit({ type: 'error', error });
        throw error;
      }
    }
  } finally {
    this.currentParams = null;
  }
}
```

关键不变量：

- **每次 retry 都会重新 append user 消息**：append 点下沉到 `runAttempt` 内、preflight 之后；配合 `sanitizeSessionTail` 在 `runAttempt`/`compactHistory` 入口清洗上一轮残留的孤立 trailing user，避免重复写入与 role alternation 冲突；
- **`runAttempt` 重新 `loadHistory` 才能感知压缩**：每次 retry 都从 session 重新读历史，新的 compaction record 会被 `loadHistory` 自动识别（截断 + 摘要注入）；
- **`MAX_COMPACTION_RETRIES = 3`**：兜底次数；超过则把 `ContextOverflowError` 向上抛给调用方；
- **`DEFAULT_COMPACTION_CONFIG` 占位**：库消费者不传 `compaction` 时使用，避免 nullable 检查散落到每条路径。

### 4.2 外层压缩重试循环

```
run() ───▶ runAttempt() ──┬─▶ RunResult                              ──▶ return
                          │
                          └─▶ throw ContextOverflowError
                                  │
                                  ▼
                       compactionAttempts < MAX_COMPACTION_RETRIES?
                                  │
                          yes ───┴─── no
                          ▼               ▼
                  compactHistory       throw 给调用方
                  retries++ → continue
```

`ContextOverflowError` 的三种触发点都汇入这一个重试循环（详见 §6.5）：

1. `runAttempt` 开头 `checkContextBudget` 预判返回 `'compact'`；
2. 内层循环 tool result 追加后估算 token 超 90% 阈值；
3. LLM API 抛 context overflow 类错误（被 `callLLMStream` 包装）。

### 4.3 runAttempt：单次完整尝试

```typescript
private async runAttempt(
  params: RunParams,
  contextWindowTokens: number,
  compaction: CompactionConfig,
): Promise<Omit<RunResult, 'compacted'>> {
  const maxLlmCalls = params.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;            // 12
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;                   // 4096

  // 0. 净化当前分支末尾的孤立 trailing user（来自上一次失败/中断的遗留）
  //    详见 §9.2 sanitizeSessionTail
  this.sanitizeSessionTail(params.sessionKey);

  // 1. 加载历史（自动感知压缩记录）
  let messages = this.loadHistory(params.sessionKey);

  // 2. Layer 1: per-result 裁剪
  if (compaction.enabled) {
    messages = pruneToolResults(messages, compaction, contextWindowTokens, (info) => {
      this.emit({ type: 'tool_result_pruned', ... });
    });
  }

  // 3. Layer 2: 预判与路由
  if (compaction.enabled) {
    const budget = checkContextBudget({
      messages, systemPrompt: params.systemPrompt, currentPrompt: params.message,
      contextWindowTokens, config: compaction,
    });
    if (budget.route === 'truncate_tool_results_only') {
      messages = pruneToolResultsAggregate(messages, contextWindowTokens, compaction);
    } else if (budget.route === 'compact') {
      throw new ContextOverflowError(`Preemptive compaction required: ...`, 'preemptive');
    }
  }

  // 4. preflight 通过 → 此时才把本次 user 消息持久化到 session 并 push 到 messages
  //    顺序：先 appendMessage（落盘）再 push（内存）。预判失败时不会污染 session。
  await this.sessionManager.appendMessage(params.sessionKey, {
    role: 'user', content: params.message,
  });
  messages = [...messages, { role: 'user', content: params.message }];

  // 5. 执行循环（见 §5）
  // ...
}
```

要点：

- **入口先清洗**：`sanitizeSessionTail` 把上一次失败/中断遗留的孤立 trailing user 从当前分支剥离（branch 回 parentId，仅改内存 `leafId`），保证后续 append 不会产生连续 user 或重复内容；
- **append 在 preflight 之后**：预判检查所用的 `messages` 不含当前用户消息，`currentPrompt` 由 `checkContextBudget` 单独计入；preflight 抛 `ContextOverflowError('preemptive')` 时 user 尚未落盘，下一轮压缩重试的输入干净；
- **Layer 1 / Layer 1.5 / Layer 2** 都在循环之前完成；Layer 3（LLM 摘要）由外层捕获 `ContextOverflowError` 后驱动；
- 当前层级语义见 [Current Runner](../current/core_runner.md)，落盘点下沉的设计动机见 [core-runner-turn-flow-spec](../core-runner-turn-flow-spec.md)。

---

## 5. 执行循环

```
runAttempt 主体
  │
  ├─ 初始化：totalUsage / totalToolRounds / lastContent / lastStopReason / llmCallCount = 0
  │  hasMoreToolCalls = true   ← 初始 true，保证至少一次 LLM 调用
  │
  │  while (hasMoreToolCalls):   ← 处理 LLM 调用 + tool calls + steering
  │    │
  │    ├─ 安全检查：llmCallCount >= maxLlmCalls?
  │    │   └─ YES → return { stopReason: 'max_llm_calls', ... }
  │    │
  │    ├─ emit { type: 'llm_call', round: llmCallCount }
  │    ├─ llmCallCount++
  │    │
  │    ├─ callLLMStream({ model, system, messages, tools, maxTokens })
  │    │   ├─ for await event of llmClient.chatStream:
  │    │   │   ├─ text_delta → emit + 收集
  │    │   │   ├─ tool_use   → 收集 content block
  │    │   │   ├─ message_end → 记录 stopReason + usage
  │    │   │   └─ error      → throw
  │    │   └─ catch isContextOverflowError → throw ContextOverflowError
  │    │
  │    ├─ 累计 totalUsage
  │    ├─ messages.push({ role: 'assistant', content: llmResult.content })
  │    ├─ session.appendMessage('assistant', content)
  │    │
  │    ├─ stopReason ∈ {'error', 'aborted'}? → return
  │    │
  │    ├─ 检查 content 中有 tool_use blocks?
  │    │   ├─ NO → hasMoreToolCalls = false
  │    │   └─ YES:
  │    │       ├─ 遍历每个 toolUse:
  │    │       │   ├─ emit { type: 'tool_use', name, input }
  │    │       │   ├─ before_tool_call hooks（sequential, priority 降序）
  │    │       │   │   ├─ deny → 用 blocked ToolResult 占位、emit tool_result
  │    │       │   │   └─ allow → effectiveInput = beforeResult.input
  │    │       │   ├─ executeTool(name, effectiveInput)
  │    │       │   ├─ emit { type: 'tool_result', name, result }
  │    │       │   └─ after_tool_call hooks（parallel, fire-and-forget）
  │    │       │
  │    │       ├─ messages.push({ role: 'user', content: toolResultBlocks })
  │    │       ├─ session.appendMessage('toolResult', toolResultBlocks)
  │    │       ├─ Layer 1: pruneToolResults（新 tool result 追加后）
  │    │       ├─ 90% 阈值检查：
  │    │       │   ├─ estimatePromptTokens > contextWindow * 0.9? → throw ContextOverflowError
  │    │       ├─ totalToolRounds++
  │    │       └─ getSteeringMessages reader → 若有则 appendInjectedMessages
  │
  └─ return { text, content, stopReason, usage, toolRounds }
```

### 5.1 配额：`maxLlmCalls`

- 计数对象是"实际发起的 LLM 调用"，包括没有 tool use 的轮次；
- 检查在每次 LLM 调用前，**触发上限时立即返回 `stopReason = 'max_llm_calls'`**，保留最后一次 LLM 回复；
- 默认值 12，由 runtime 通过 `RunParams.maxLlmCalls` 透传（runtime 端默认 12 来自 `runner.maxLlmCalls` config）。

### 5.2 emit + hook 触发时机

| 时机 | Emit | Hook |
|---|---|---|
| run 开始 | `run_start` | — |
| 每次 LLM 调用前 | `llm_call` | — |
| 流式收到 text | `text_delta` | — |
| tool use 检测后、执行前 | `tool_use`（原始 input） | `before_tool_call`（sequential, priority 降序，允许修改 input / deny） |
| tool 执行完成 | `tool_result` | `after_tool_call`（parallel, fire-and-forget） |
| tool result 裁剪触发 | `tool_result_pruned` | — |
| 压缩开始 | `compaction_start` | `before_compaction` |
| 压缩完成 | `compaction_end` | `after_compaction` |
| run 成功结束 | `run_end` | — |
| run 失败 | `error`（同时 throw） | — |

当前 Hook 行为见 [Current Runner](../current/core_runner.md)，durable contract 见 [Tool/Hook Module Spec](../tool-hook-module-spec.md)。

### 5.3 stopReason 取值

| stopReason | 触发条件 |
|---|---|
| `'end_turn'` | LLM 返回 stop_reason='end_turn'，没有 tool_use blocks |
| `'max_llm_calls'` | LLM 调用次数达到 `maxLlmCalls` 上限 |
| `'error'` | LLM 内部错误 |
| `'aborted'` | 上游主动中止 |
| 其它 | 直接透传 llm 返回的 stop_reason |

---

## 6. 上下文管理（4 层）

| 层 | 实现 | 调 LLM？ | 触发时机 |
|---|---|---|---|
| **Layer 1** | `pruneToolResults` | 否 | `runAttempt` 开头；每轮 tool result 追加后 |
| **Layer 1.5** | `pruneToolResultsAggregate` | 否 | Layer 2 路由到 `'truncate_tool_results_only'` 时 |
| **Layer 2** | `checkContextBudget` | 否 | `runAttempt` 开头（在 delay-append 之前） |
| **Layer 3** | `compactMessages` | 是 | 外层捕获 `ContextOverflowError` 后调用 |

### 6.1 Layer 1：per-result 裁剪

对每条 tool result 单独裁剪超长内容；不调 LLM，纯内存操作。每次裁剪触发 `tool_result_pruned` 事件，便于 channel / telemetry 观察。

调用点：

- `runAttempt` 开头（历史消息中的 tool result）；
- 内层循环 tool result 追加后（新增 tool result）。

### 6.2 Layer 1.5：聚合裁剪

只在 Layer 2 路由为 `'truncate_tool_results_only'` 时触发。把所有 tool result 总量压入聚合预算（仍不调 LLM）。

### 6.3 Layer 2：预判路由

`checkContextBudget` 计算 `messages + systemPrompt + currentPrompt` 的估算 token，返回三种路由：

- `'fits'`：直接继续；
- `'truncate_tool_results_only'`：调 Layer 1.5；
- `'compact'`：抛 `ContextOverflowError('preemptive')`，让外层走 Layer 3。

### 6.4 Layer 3：LLM 摘要压缩

由 `compactHistory` 编排：

```typescript
private async compactHistory(
  params: RunParams,
  compaction: CompactionConfig,
  trigger: 'preemptive' | 'overflow' | 'manual',
): Promise<void> {
  // 0. 净化当前分支末尾的孤立 trailing user
  //    - preemptive 触发：runAttempt 已先净化，此处 no-op；
  //    - overflow 触发：runAttempt 已 append 过 user，此处把这条剥离，
  //      避免它进入 compactMessages 的输入，并稳定 firstKeptEntryId 指针。
  //    详见 §9.2 sanitizeSessionTail。
  this.sanitizeSessionTail(params.sessionKey);

  const messages = this.loadHistory(params.sessionKey);
  const estimatedTokens = estimatePromptTokens({ messages });

  // 触发 before_compaction hook（observer）
  runBeforeCompaction(hooks, { trigger, estimatedTokens, turnId, sessionKey });
  this.emit({ type: 'compaction_start', trigger, estimatedTokens });

  const compactResult = await compactMessages({ messages, config: compaction, llmClient, model, trigger });

  // 找到保留区第一条消息的 entryId，用于截断锚点
  const keptCount = compactResult.messages.length - 1;
  const allMessages = this.sessionManager.getMessages(params.sessionKey);
  const firstKeptIndex = Math.max(0, allMessages.length - keptCount);
  const firstKeptEntryId = allMessages[firstKeptIndex]?.id ?? allMessages[0]?.id ?? '';

  await this.sessionManager.appendCompactionRecord(params.sessionKey, compactResult.record, firstKeptEntryId);

  // 触发 after_compaction hook（observer）
  runAfterCompaction(hooks, { trigger, tokensBefore, tokensAfter, droppedMessages, turnId, sessionKey });
  this.emit({ type: 'compaction_end', tokensBefore, tokensAfter, droppedMessages });

  await this.sessionManager.updateSession(params.sessionKey, { totalTokens: compactResult.stats.tokensAfter });
}
```

要点：

- **压缩记录持久化到 session JSONL**：`appendCompactionRecord` 同时更新 session 元数据（`compactionRecord.firstKeptEntryId`）；
- **下次 `loadHistory` 自动应用**：从 `firstKeptEntryId` 开始截断 + 在最前面注入摘要消息；
- **hook 是 observer-only**：当前 `before_compaction` / `after_compaction` 返回 `void | Promise<void>`，不能否决压缩——与 `compaction_*` 事件能力等价，差别只在 priority 与 await 时序。

### 6.5 三条溢出路径统一为 `ContextOverflowError`

```
runAttempt 开头预判:                                ContextOverflowError(trigger='preemptive')
内层循环 tool result 追加后 90% 阈值:               ContextOverflowError（trigger 默认为 'overflow'）
LLM API 抛 context overflow 类错误:                 callLLMStream 包装为 ContextOverflowError
                                                              │
                                                              ▼
                                                  外层 run() 捕获 → compactHistory → retry
```

`callLLMStream` 内部：

```typescript
try {
  for await (const event of this.llmClient.chatStream(...)) { /* ... */ }
} catch (err) {
  if (err instanceof Error && isContextOverflowError(err)) {
    throw new ContextOverflowError(`LLM API context overflow: ${err.message}`);
  }
  throw err;
}
```

`isContextOverflowError` 由 `errors.ts` 提供，识别 LLM API 返回的具体 error code / message。

---

## 7. In-turn 消息注入

Runner 只有一个 in-turn 注入点：**每轮 tool 执行结束后**，调用 `getSteeringMessages` reader 拉取额外消息并合并到 `messages`。

reader 实现由 runtime 提供；不提供时 runner 视为无 steering 输入（reader 返回 `[]`，注入点空操作）。详见 [message-flow](./core-runner-message-flow.md)。

### 7.1 注入时机

```
执行循环每轮 tool 执行后:
  └─ getSteeringMessages reader → 若有则 appendInjectedMessages
```

实现：

```typescript
// 每轮 tool 后内联调用
const steeringMessages = await this.readPendingMessages(params.getSteeringMessages);
if (steeringMessages.length > 0) {
  await this.appendInjectedMessages(params.sessionKey, messages, steeringMessages);
}
```

`readPendingMessages` 是私有 helper，未提供 reader 时直接返回 `[]`。

### 7.2 注入消息的处理

```typescript
private async appendInjectedMessages(
  sessionKey: string,
  targetMessages: ChatMessage[],
  injectedMessages: ChatMessage[],
): Promise<void> {
  for (const message of injectedMessages) {
    targetMessages.push(message);
    await this.sessionManager.appendMessage(sessionKey, { role: message.role, content: message.content });
  }
}
```

要点：

- **同时追加到内存 `messages` 和持久化 session**：保证下次 `loadHistory` 能看到；
- **`readPendingMessages` 做防御性过滤**：要求每条消息有 `role` ∈ `{user, assistant}` 与 `content` 字段，非法形态被丢弃；
- **runner 不感知 followup 语义**：followup 由 RuntimeApp 入站队列承担——上一个 turn 结束后队头自然启动新 turn，runner 端只处理单 turn 内的 steering。

---

## 8. Hook 系统

### 8.1 Hook 类型

| Hook | 时机 | 执行模型 | 能否修改/否决 |
|---|---|---|---|
| `before_tool_call` | tool 执行前 | sequential, priority 降序 | ✅ 可改 input / deny |
| `after_tool_call` | tool 执行后 | parallel, fire-and-forget | ❌ |
| `before_compaction` | 压缩开始前 | parallel, fire-and-forget | ❌（observer-only） |
| `after_compaction` | 压缩完成后 | parallel, fire-and-forget | ❌（observer-only） |

### 8.2 注册 API

```typescript
on<K extends HookName>(
  hookName: K,
  handler: HookHandlerMap[K],
  options?: { priority?: number; name?: string },
): this;
```

priority 数字越大越先执行；`name` 用于诊断日志。

完整的 Interceptor / Observer contract 与错误策略见 [Tool/Hook Module Spec](../tool-hook-module-spec.md)；当前接入见 [Current Runner](../current/core_runner.md)。

---

## 9. Session 持久化

每条消息在产生时立即保存到 session，而不是等全部结束后批量保存：

```
时间线（每次 runAttempt）：
  ├─ sanitizeSessionTail                            ← 清掉上一次失败/中断遗留的 trailing user
  ├─ loadHistory（感知 compaction record）
  ├─ Layer 1 / Layer 2 预判
  ├─ appendMessage('user', 用户输入)                ← preflight 通过后才写入
  ├─ LLM 调用 #1
  ├─ appendMessage('assistant', [text + tool_use])  ← 助手回复立即保存
  ├─ appendMessage('toolResult', [tool_result])     ← 工具结果立即保存（独立 role）
  ├─ LLM 调用 #2
  ├─ appendMessage('assistant', [text])             ← 最终回复立即保存
  └─ 返回结果
```

> 用户消息不在 `run()` 入口落盘，而是在 `runAttempt` 内、Layer 2 preflight 通过之后才写入；每次压缩重试都会重新执行此序列。

注入消息（steering / followUp）也走 `appendMessage`，同时追加到内存 `messages` 与 session。

### 9.1 `loadHistory` 与压缩感知

```typescript
private loadHistory(sessionKey: string): ChatMessage[] {
  const records = this.sessionManager.getMessages(sessionKey);
  const compactionRecord = this.sessionManager.getLastCompactionRecord(sessionKey);

  let effectiveRecords = records;
  if (compactionRecord) {
    const keptIndex = records.findIndex((r) => r.id === compactionRecord.firstKeptEntryId);
    if (keptIndex >= 0) {
      effectiveRecords = records.slice(keptIndex);
    }
  }

  const messages: ChatMessage[] = effectiveRecords.map((record) => {
    if (record.message.role === 'toolResult') {
      return { role: 'user', content: record.message.content };  // Anthropic API: toolResult 用 user role 携带
    }
    return { role: record.message.role, content: record.message.content };
  });

  if (compactionRecord) {
    messages.unshift({
      role: 'user',
      content: `[Previous conversation summary]\n\n${compactionRecord.summary}\n\n[End of summary. The conversation continues below.]`,
    });
  }

  return messages;
}
```

要点：

- **`toolResult` role 转 `user`**：对齐 Anthropic API 的消息序列契约；
- **压缩记录决定截断锚点**：`firstKeptEntryId` 是 session 中的 entry id，找到下标后切片；
- **摘要作为 `user` 消息注入开头**：让 LLM 感知"之前发生过什么"；
- **每次 `runAttempt` 都重新 `loadHistory`**：retry 期间产生的新压缩记录会被即时应用。

### 9.2 `sanitizeSessionTail`：清洗孤立 trailing user

`runAttempt` 与 `compactHistory` 入口都会调用 `sanitizeSessionTail(sessionKey)`。它检查 `getMessages(sessionKey)` 返回的当前分支末尾，若末尾消息 `role === 'user'`（即上一次 LLM 调用未触达或失败、进程崩溃等场景遗留的孤立 user），则通过 `branch(parentId)` 把 leaf 指针回退到其父节点，并 emit `session_tail_sanitized`。

```typescript
private sanitizeSessionTail(sessionKey: string): void {
  const records = this.sessionManager.getMessages(sessionKey);
  if (records.length === 0) return;

  const last = records[records.length - 1]!;
  if (last.message.role !== 'user') {
    if (last.message.role === 'toolResult') {
      logger.warn('[sanitizeSessionTail] session tail is toolResult (interrupted mid-tool-call); skipping cleanup', {
        sessionKey, entryId: last.id,
      });
    }
    return;
  }

  const parentId = last.parentId;
  if (!parentId) return;  // 防御性：user message 在 byId 中必有 parentId 指向 session 根

  this.sessionManager.branch(sessionKey, parentId);
  this.emit({ type: 'session_tail_sanitized', discardedEntryId: last.id, discardedRole: 'user' });
}
```

要点：

- **仅修改内存 `leafId`，不写 JSONL**：被剥离的 entry 仍保留在文件中可审计，多次 retry 不会破坏 append-only 契约；
- **只清 trailing user，不清 trailing toolResult**：tool 可能已经产生副作用（写文件、发消息等），保留 toolResult 让下一轮 LLM 基于已有进度继续推理；末尾若是 toolResult 仅记 warn 日志，不主动修复；
- **`compactHistory` 也需调用**：overflow 触发的压缩此时 `runAttempt` 已 append 过当前轮 user；若不清掉，`appendCompactionRecord(firstKeptEntryId)` 会把指针写到一条"下轮即将被清出当前分支"的 entry 上，导致下一轮 `loadHistory` 的 `findIndex(firstKeptEntryId)` 返回 -1、截断失效、摘要与全量历史重叠；
- **幂等**：清洗一次后末尾不再是 user，再调一次直接 return；
- **设计动机与边界场景**详见 [core-runner-turn-flow-spec](../core-runner-turn-flow-spec.md)。

---

## 10. Event emit 机制

### 10.1 currentParams 自动注入

```typescript
private currentParams: RunParams | null = null;

private emit(event: AgentEventInput): void {
  if (!this.onEvent) return;
  if (!this.currentParams) return;   // 防御性：理论上 emit 只在 run() 期间调用
  this.onEvent({
    ...event,
    sessionKey: this.currentParams.sessionKey,
    turnId: this.currentParams.turnId,
  } as AgentEvent);
}
```

`run()` 入口设置 `currentParams = params`，`finally` 中清理回 `null`。emit 调用方只写自己关心的字段，`sessionKey` / `turnId` 由 emit 自动注入。

### 10.2 AgentEventInput 私有类型

```typescript
type AgentEventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'sessionKey' | 'turnId'>
    : never
  : never;
```

利用条件类型分发，给每个 variant 单独 `Omit<..., 'sessionKey' | 'turnId'>`，保留各自的 discriminator。

**不导出**——这是 emit 的内部便利类型；对外暴露的仍是平铺的 `AgentEvent`。

---

## 11. 错误处理

### 11.1 ContextOverflowError

```typescript
export class ContextOverflowError extends Error {
  constructor(
    message: string,
    public readonly trigger: 'preemptive' | 'overflow' | 'manual' = 'overflow',
  ) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}
```

`trigger` 字段：

- `'preemptive'`：`runAttempt` 开头预判触发；
- `'overflow'`：内层 90% 阈值或 LLM API 错误触发；
- `'manual'`：调用方主动触发压缩（暂未使用）。

### 11.2 LLM API context overflow 包装

```typescript
try {
  for await (const event of this.llmClient.chatStream(...)) { /* ... */ }
} catch (err) {
  if (err instanceof Error && isContextOverflowError(err)) {
    throw new ContextOverflowError(`LLM API context overflow: ${err.message}`);
  }
  throw err;
}
```

`isContextOverflowError` 在 `errors.ts` 中实现，识别 Anthropic API 返回的具体错误形态（如 `prompt is too long`）。

### 11.3 上抛策略

```
ContextOverflowError → 外层 retry 循环（最多 3 次）→ 仍失败则抛给调用方
其它 Error → emit { type: 'error', error } + throw
```

`run()` 的 `finally` 始终清理 `currentParams`，确保下次调用从干净状态开始。

---

## 12. 使用示例

### 12.1 基本对话（无工具）

```typescript
import { AgentRunner } from './core/runner';
import { AnthropicClient } from './adapters/llm';
import { SessionManager } from './core/session';
import { SystemPromptBuilder } from './core/prompt';
import { randomUUID } from 'node:crypto';

const llmClient = new AnthropicClient({ apiKey });
const sessionManager = new SessionManager('./workspace');
const runner = new AgentRunner({ llmClient, sessionManager });

const systemPrompt = new SystemPromptBuilder().build({ /* ... */ });

const result = await runner.run({
  sessionKey: 'main',
  message: 'Hello!',
  model: 'claude-sonnet-4-6',
  systemPrompt,
  turnId: randomUUID(),
});
```

### 12.2 带工具与事件回调

```typescript
const runner = new AgentRunner({
  llmClient,
  sessionManager,
  toolExecutor: async (toolName, input) => ({ content: `Result of ${toolName}` }),
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
  turnId: randomUUID(),
  tools: [{ name: 'get_weather', description: '...', input_schema: { /* ... */ } }],
  maxLlmCalls: 5,
});
```

### 12.3 注册 hook

```typescript
runner.on('before_tool_call', async ({ toolName, input }) => {
  if (toolName === 'exec') {
    return { action: 'deny', reason: 'Tool blocked by policy' };
  }
  return { action: 'allow' };
}, { priority: 100, name: 'policy-gate' });

runner.on('after_tool_call', async ({ toolName, durationMs }) => {
  console.log(`[metric] ${toolName} took ${durationMs}ms`);
});
```

### 12.4 在 RuntimeApp 内部的典型调用形态

参考实际接线：

```typescript
const result = await this.resources.agentRunner.run({
  sessionKey: params.sessionKey,
  message: builtUserPrompt.text,
  model: this.requireModel(params.model),
  systemPrompt,
  turnId: params.turnId,
  tools: this.resources.toolBundle.llmDefinitions,
  maxTokens: params.maxTokens ?? this.resources.resolvedConfig.llm.maxTokens,
  maxLlmCalls: params.maxLlmCalls ?? this.resources.resolvedConfig.runner.maxLlmCalls,
  getSteeringMessages: async () => this.drainSteeringMessages(params.sessionKey),
  compaction: this.resources.resolvedConfig.compaction,
  contextWindowTokens: this.resources.resolvedConfig.llm.contextWindowTokens,
});
```

---

## 13. 测试覆盖

| 测试类别 | 主要用例 |
|---|---|
| 基本对话 | 单次 text 回复 / 多轮历史 / 空回复 / 多 session 隔离 |
| Tool use loop | 单次 tool / 多次 tool / `max_llm_calls` 触发 / 无 `toolExecutor` / `isError` 传递 |
| 事件回调 | `run_start` / `run_end` / `text_delta` / `tool_use` / `tool_result` / `llm_call` 触发顺序 |
| Session 持久化 | user → assistant(tool_use) → toolResult → assistant(text) 写入顺序 |
| Hook | `before_tool_call` allow / deny / 修改 input；`after_tool_call` 触发；priority 排序 |
| Compaction hooks | `before_compaction` / `after_compaction` 触发；payload 正确 |
| 上下文管理 | Layer 1 触发 `tool_result_pruned`；Layer 2 路由 fits / truncate / compact；Layer 3 写入 compaction record 与 session 元数据；retry 后 `loadHistory` 看到摘要 |
| ContextOverflowError 三条路径 | 预判路径、内层 90%、API 错误三种触发 + 外层 retry + 超过 `MAX_COMPACTION_RETRIES` 后抛出 |
| `sanitizeSessionTail` | 末尾为 user 时回退 leaf + emit `session_tail_sanitized`；末尾为 assistant/toolResult/空 session 时 no-op；幂等；首条 user 时回退到 session 根；overflow 压缩重试链路下 `firstKeptEntryId` 截断仍生效 |
| In-turn message readers | `getSteeringMessages` 每轮 tool 后消费；reader 未提供时返回空 |
| AgentEvent 形状 | 所有 variant 都自带 `sessionKey` / `turnId`；emit 自动注入；`currentParams = null` 时不 emit |

新增测试时建议用 `test-helpers.makeRunParams()` 减少 `turnId` 等样板。

---

## 14. 已知未实现 / 规划项

| 项 | 状态 | 说明 |
|---|---|---|
| 模型 fallback | 规划中 | 主模型失败时切换备用模型；需要独立设计 fallback 策略与 metric |
| AbortSignal | 规划中 | 用户取消；需要 LLM 流、tool executor、hook 三处协议同步支持 |
| 硬 steering | 规划中 | AbortSignal + tool cancellation + LLM 流中断；用以打断在飞的 LLM / tool |
| 历史裁剪策略 | 规划中 | 除 compaction 之外的轻量级历史窗口截断 |
| `RunResult.compactionStats` | 待讨论 | 详细统计是否在 `RunResult` 暴露待明确消费方 |
| `before_compaction` 否决能力 | 规划中 | 给 hook 增加 `{ action: 'skip' \| 'continue' }` 返回类型，解锁 dryrun / 速率限制 / 强制降级 |
| `manual` trigger 触发 compaction | 规划中 | 当前 `'manual'` trigger 已在类型中预留，但 AgentRunner 暂无对外的"手动压缩"入口 |
| `tool_use` 阶段 steering | 规划中 | 当前 steering 仅在 tool 执行后检查；未来可在 tool 执行**前**检查，覆盖 "正在执行长耗时 tool 时收到 steering" 的延迟 |

---

## 15. 总结

Agent Runner 把"一次对话循环如何执行"封装为单一引擎：

1. **执行循环**：LLM 调用 + tool use + steering 注入，单层 `while`；
2. **上下文管理**：4 层渐进策略（per-result 裁剪 → 聚合裁剪 → 预判路由 → LLM 摘要），所有溢出路径统一为 `ContextOverflowError` + 外层重试；
3. **事件与 hook 分层**：emit 走单一 onEvent 入口，hook 走 `on()` 注册 API，sessionKey/turnId 由 `currentParams` 自动注入；
4. **配置边界清晰**：runtime 解析配置后只传需要的最小子集，runner 不接触 config loader；
5. **可被 channel 层透明接管**：runner 不感知 channel / approval 概念，所有跨层路由由 RuntimeApp 与 TurnInteractionManager 完成。

设计的核心收益是把"agent 怎么走完一次对话"和"消息怎么来、approval 怎么回"两个关注点分开，让 runner 专注前者。
