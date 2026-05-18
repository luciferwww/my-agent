# Agent Runner 变更说明（v0.9 → v1.0）

> 版本：v1.0
> 创建日期：2026-05-18
> 标准设计文档：[core-runner-design.md](./core-runner-design.md)
> v0.9 文档：[../core-runner-design.md](../core-runner-design.md)

本文档描述 Agent Runner 从 v0.9 升级到 v1.0 的所有变更。仅作为升级参考；canonical 设计请看同目录 [core-runner-design.md](./core-runner-design.md)。

---

## 1. 变更速览

| 维度 | v0.9 | v1.0 |
|---|---|---|
| 配额参数 | `maxLlmCalls`（已在 v0.9 文档中应用） | 同 v0.9；默认 12 在 runner 内 `DEFAULT_MAX_LLM_CALLS` |
| In-turn message reader API | 文档仅描述抽象概念，refs `steering-followup-design.md` | 显式三个 reader：`getInTurnMessages` / `getSteeringMessages` / `getFollowUpMessages`；按 `inTurnMessageMode` 路由 |
| 默认 `inTurnMessageMode` | 未定义 | `'followup'`（`DEFAULT_IN_TURN_MESSAGE_MODE`） |
| 上下文管理 | 仅有"压缩是后续优化"的说明 | 4 层渐进策略落地（Layer 1 / 1.5 / 2 / 3） |
| 压缩重试 | 无 | 外层 `run()` 捕获 `ContextOverflowError` + `MAX_COMPACTION_RETRIES = 3` 重试 |
| 内层 90% 阈值 | 无 | 每次 tool result 追加后做主动检测 |
| LLM API context overflow 处理 | 无 | `callLLMStream` 内捕获 + 包装为 `ContextOverflowError` |
| `RunParams` 新增字段 | — | `compaction` / `contextWindowTokens` / `getInTurnMessages` / `getSteeringMessages` / `getFollowUpMessages` |
| `RunResult` 新增字段 | — | `compacted: boolean` |
| `AgentEvent` 新增 variant | `run_start` / `text_delta` / `tool_use` / `tool_result` / `llm_call` / `run_end` / `error` | 新增 `tool_result_pruned` / `compaction_start` / `compaction_end` |
| `compaction_start` payload | n/a | 含 `estimatedTokens`（不是已知准确的 `tokensBefore`） |
| Hook 类型 | `before_tool_call` / `after_tool_call` | 增加 `before_compaction` / `after_compaction`（observer-only） |
| emit 实现 | v0.9 文档没展开实现细节 | 用 `currentParams` 自动注入 `sessionKey` / `turnId`；私有 `AgentEventInput` 类型作为 emit 调用方便利输入 |
| `loadHistory` 压缩感知 | 未涉及 | 检测 `compactionRecord`，按 `firstKeptEntryId` 截断历史 + 在最前面注入摘要消息 |
| delay-append currentPrompt | 未涉及 | 预判通过后才把当前用户消息加入 messages，预判失败时不污染重试 |
| `DEFAULT_COMPACTION_CONFIG` 占位 | 未涉及 | 调用方不传 `compaction` 时使用，避免 nullable 散落 |
| 引用 `steering-followup-design.md` | 有 | 文档已删除；改为引用 [core-runner-message-flow.md](./core-runner-message-flow.md) |

---

## 2. 类型变更

### 2.1 `RunParams` 新增字段

```diff
 export interface RunParams {
   sessionKey: string;
   message: string;
   model: string;
   systemPrompt: string;
   turnId: string;
   tools?: ToolDefinition[];
   maxTokens?: number;
   maxLlmCalls?: number;
   inTurnMessageMode?: 'steer' | 'followup';
+  /**
+   * 通用 turn 内消息读取回调。
+   * 根据 inTurnMessageMode 路由到 steering 或 followUp 注入点。
+   */
+  getInTurnMessages?: PendingMessageReader;
+  /** steering 专用消息读取回调（总在 steering 注入点消费） */
+  getSteeringMessages?: PendingMessageReader;
+  /** followUp 专用消息读取回调（总在 followUp 注入点消费） */
+  getFollowUpMessages?: PendingMessageReader;
+  /** 压缩配置（由 RuntimeApp 传入） */
+  compaction?: CompactionConfig;
+  /** 模型上下文窗口大小（由 RuntimeApp 从 config.llm.contextWindowTokens 传入），默认 200,000 */
+  contextWindowTokens?: number;
 }

+export type PendingMessageReader = () => ChatMessage[] | Promise<ChatMessage[]>;
+export type InTurnMessageMode = 'steer' | 'followup';
```

**影响**：

- 直接调用 `AgentRunner.run()` 的库消费者，若想启用 compaction 必须显式传 `compaction` 与 `contextWindowTokens`，否则使用 `DEFAULT_COMPACTION_CONFIG`（启用、默认参数）；
- 想接入 in-turn steering 必须自己提供 `getSteeringMessages` reader——RuntimeApp 已经为 channel 场景接好（详见 [message-flow](./core-runner-message-flow.md)）；
- `inTurnMessageMode` 缺省值 `'followup'`，与 runtime config 默认一致。

### 2.2 `RunResult` 新增 `compacted`

```diff
 export interface RunResult {
   text: string;
   content: ChatContentBlock[];
   stopReason: string;
   usage: TokenUsage;
   toolRounds: number;
+  /** 本次运行是否触发了压缩 */
+  compacted?: boolean;
 }
```

详细的压缩统计仅通过 `compaction_end` 事件提供，**不**在 `RunResult` 字段中暴露（待消费方明确再决定）。

### 2.3 `AgentEvent` 新增 variant

```diff
 export type AgentEvent =
   | { type: 'run_start'; sessionKey: string; turnId: string }
   | { type: 'text_delta'; sessionKey: string; turnId: string; text: string }
   | { type: 'tool_use'; sessionKey: string; turnId: string; name: string; input: Record<string, unknown> }
   | { type: 'tool_result'; sessionKey: string; turnId: string; name: string; result: ToolResult }
   | { type: 'llm_call'; sessionKey: string; turnId: string; round: number }
   | { type: 'run_end'; sessionKey: string; turnId: string; result: RunResult }
   | { type: 'error'; sessionKey: string; turnId: string; error: Error }
+  | {
+      type: 'tool_result_pruned';
+      sessionKey: string;
+      turnId: string;
+      toolUseId: string;
+      originalChars: number;
+      prunedChars: number;
+    }
+  | {
+      type: 'compaction_start';
+      sessionKey: string;
+      turnId: string;
+      trigger: 'preemptive' | 'overflow' | 'manual';
+      estimatedTokens: number;
+    }
+  | {
+      type: 'compaction_end';
+      sessionKey: string;
+      turnId: string;
+      tokensBefore: number;
+      tokensAfter: number;
+      droppedMessages: number;
+    };
```

**影响**：

- 订阅 `onEvent` 的代码处理 default case 的方式要更新（增加三种新 variant）；
- channel 层若要把 `tool_result_pruned` / `compaction_*` 透传给前端，需要在 channel.send 内添加分支（CliChannel 与 WebSocketChannel 已实现）。

---

## 3. 行为变更

### 3.1 外层压缩重试循环

v0.9：`run()` 内只有两层循环，遇到 context overflow 直接抛错。

v1.0：`run()` 在两层循环外再包一层重试：

```typescript
async run(params): Promise<RunResult> {
  this.currentParams = params;
  try {
    this.emit({ type: 'run_start' });
    await this.sessionManager.appendMessage(sessionKey, { role: 'user', content: message });

    let compactionAttempts = 0;
    let compacted = false;

    while (true) {
      try {
        const result = await this.runAttempt(params, contextWindowTokens, compaction);
        const finalResult = { ...result, compacted };
        this.emit({ type: 'run_end', result: finalResult });
        return finalResult;
      } catch (err) {
        if (err instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
          await this.compactHistory(params, compaction, err.trigger);
          compacted = true;
          compactionAttempts++;
          continue;
        }
        this.emit({ type: 'error', error: ... });
        throw err;
      }
    }
  } finally {
    this.currentParams = null;
  }
}
```

要点：

- **用户消息只 append 一次**（外层重试前），retry 期间不重复写入；
- **`MAX_COMPACTION_RETRIES = 3`**：超过次数仍失败则向上抛 `ContextOverflowError`；
- **`compacted` 字段反映"本次 run 是否至少触发过一次压缩"**。

### 3.2 三条溢出路径

v0.9：无统一的 overflow 错误模型。

v1.0：所有路径统一抛 `ContextOverflowError`：

| 路径 | 触发位置 | trigger 值 |
|---|---|---|
| 预判 | `runAttempt` 开头 `checkContextBudget` 返回 `'compact'` | `'preemptive'` |
| 内层 90% 阈值 | tool result 追加后 `estimatePromptTokens > 0.9 * contextWindow` | `'overflow'` |
| LLM API 错误 | `callLLMStream` 捕获 + `isContextOverflowError` 判定 | `'overflow'` |

所有路径都进入外层 retry 循环。

### 3.3 `loadHistory` 压缩感知

v0.9：直接从 session 加载消息序列。

v1.0：检测 session 上的 `compactionRecord`，按 `firstKeptEntryId` 截断历史，并在最前面注入摘要消息：

```typescript
private loadHistory(sessionKey: string): ChatMessage[] {
  const records = this.sessionManager.getMessages(sessionKey);
  const compactionRecord = this.sessionManager.getLastCompactionRecord(sessionKey);

  let effectiveRecords = records;
  if (compactionRecord) {
    const keptIndex = records.findIndex((r) => r.id === compactionRecord.firstKeptEntryId);
    if (keptIndex >= 0) effectiveRecords = records.slice(keptIndex);
  }

  const messages = effectiveRecords.map((record) => {
    if (record.message.role === 'toolResult') {
      return { role: 'user', content: record.message.content };
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

**影响**：

- session 中 compactionRecord 由 `compactHistory` 写入；外层 retry 时下次 `loadHistory` 自动应用；
- 旧 session（无 compactionRecord）行为不变。

### 3.4 delay-append currentPrompt

v0.9：用户消息直接 push 到 messages 一起送 LLM。

v1.0：预判检查（Layer 2）所用的 messages **不含**当前用户消息；`currentPrompt` 单独计入预算；预判通过后才把当前消息加入 messages：

```typescript
// 预判使用 messages（不含 currentPrompt）+ currentPrompt 单独
const budget = checkContextBudget({
  messages, systemPrompt, currentPrompt: params.message, contextWindowTokens, config: compaction,
});
// 预判通过后才 append
messages = [...messages, { role: 'user', content: params.message }];
```

**影响**：

- 当前用户消息永远不会被 Layer 1 / 1.5 裁剪——它是本轮的主输入；
- 预判失败抛出 `ContextOverflowError` 时，messages 没被污染，retry 时重新走一遍预判。

### 3.5 In-turn message readers

v0.9：仅描述抽象概念，引用已删除的 `steering-followup-design.md`。

v1.0：显式三个 reader，由 `getSteeringMessages` / `getFollowUpMessages` 私有方法消费：

```typescript
private async getSteeringMessages(params, mode): Promise<ChatMessage[]> {
  const explicit = await this.readPendingMessages(params.getSteeringMessages);
  if (mode !== 'steer') return explicit;
  const generic = await this.readPendingMessages(params.getInTurnMessages);
  return [...explicit, ...generic];
}

private async getFollowUpMessages(params, mode): Promise<ChatMessage[]> {
  const explicit = await this.readPendingMessages(params.getFollowUpMessages);
  if (mode !== 'followup') return explicit;
  const generic = await this.readPendingMessages(params.getInTurnMessages);
  return [...explicit, ...generic];
}
```

- `readPendingMessages` 做防御性过滤：每条消息必须有 `role` ∈ `{user, assistant}` 和 `content`；
- 注入消息同时追加到内存 `messages` 与持久化 session（通过 `appendInjectedMessages`）。

详细的 reader 来源、与 RuntimeApp 的关系见 [message-flow](./core-runner-message-flow.md)。

### 3.6 emit + currentParams 自动注入

v0.9：文档没展开 emit 实现细节，AgentEvent 类型已要求每个 variant 自带 `sessionKey` / `turnId`。

v1.0：实现机制公开——`AgentRunner` 持 `currentParams: RunParams | null` 字段，`run()` 入口设置，`finally` 清理；emit 用一个私有的分发式 `Omit` 类型作为输入，从 `currentParams` 自动注入两个字段：

```typescript
private currentParams: RunParams | null = null;

type AgentEventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'sessionKey' | 'turnId'>
    : never
  : never;

private emit(event: AgentEventInput): void {
  if (!this.onEvent || !this.currentParams) return;
  this.onEvent({
    ...event,
    sessionKey: this.currentParams.sessionKey,
    turnId: this.currentParams.turnId,
  } as AgentEvent);
}
```

**影响**：

- emit 调用方写法变简洁：`this.emit({ type: 'text_delta', text })` 而不是 `this.emit({ type: 'text_delta', text, sessionKey, turnId })`；
- 测试中 emit 出来的 AgentEvent 都有完整字段——若用 `toEqual` 严格匹配，需要补字段或改用 `toMatchObject`。

### 3.7 LLM API context overflow 包装

v0.9：未涉及。

v1.0：`callLLMStream` 内部 try/catch + `isContextOverflowError` 判定 + 包装为 `ContextOverflowError`，让外层 retry 能统一处理：

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

`isContextOverflowError` 由 `errors.ts` 提供，识别 Anthropic API 返回的具体错误形态。

---

## 4. 新增方法 / 字段

### 4.1 AgentRunner 私有方法

| 方法 | 用途 |
|---|---|
| `runAttempt(params, contextWindowTokens, compaction)` | 单次完整对话尝试（不含外层 retry） |
| `compactHistory(params, compaction, trigger)` | Layer 3 LLM 摘要压缩；写入 session + emit `compaction_*` + 触发 `before/after_compaction` hook |
| `loadHistory(sessionKey)` | 加载历史并感知压缩记录（截断 + 摘要注入） |
| `callLLMStream(params)` | 流式调用 LLM + 包装 context overflow 错误 |
| `executeTool(toolName, input)` | tool 执行 + 缺省 toolExecutor 错误兜底 |
| `extractText(content)` | 从 content blocks 中提取文本 |
| `appendInjectedMessages(sessionKey, targetMessages, injectedMessages)` | 注入消息同时追加内存 + session |
| `readPendingMessages(reader)` | 调 reader 并做防御性过滤 |
| `getSteeringMessages(params, mode)` | 拉取 steering 注入点消费的消息 |
| `getFollowUpMessages(params, mode)` | 拉取 followUp 注入点消费的消息 |
| `getHooks(hookName)` | 按 hook 名取已注册 handler（priority 降序排序） |
| `emit(event)` | 内部 emit 工具（自动注入 sessionKey/turnId） |

### 4.2 模块级常量

```typescript
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_LLM_CALLS = 12;
const DEFAULT_IN_TURN_MESSAGE_MODE = 'followup';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const MAX_COMPACTION_RETRIES = 3;
const INNER_LOOP_OVERFLOW_THRESHOLD = 0.9;

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTurns: 3,
  toolResultContextShare: 0.5,
  toolResultHeadChars: 10_000,
  toolResultTailChars: 5_000,
  timeoutSeconds: 300,
};
```

### 4.3 hook 系统扩展

新增两个 hook 类型（详见 [hooks-design.md](../core-runner-hooks-design.md)）：

```typescript
export interface BeforeCompactionPayload {
  trigger: 'preemptive' | 'overflow' | 'manual';
  estimatedTokens: number;
  turnId: string;
  sessionKey: string;
}
export type BeforeCompactionHook = (payload: BeforeCompactionPayload) => void | Promise<void>;

export interface AfterCompactionPayload {
  trigger: 'preemptive' | 'overflow' | 'manual';
  tokensBefore: number;
  tokensAfter: number;
  droppedMessages: number;
  turnId: string;
  sessionKey: string;
}
export type AfterCompactionHook = (payload: AfterCompactionPayload) => void | Promise<void>;

export type HookName =
  | 'before_tool_call' | 'after_tool_call'
  | 'before_compaction' | 'after_compaction';
```

两个 compaction hook 都是 observer-only（返回 `void | Promise<void>`），不能否决压缩。当前能力与 `compaction_*` 事件等价，差别仅在 priority 排序与 `await` 时序。

---

## 5. 升级 checklist

如果你在 v0.9 之上有自定义 AgentRunner 调用或扩展：

1. **`onEvent` 处理**：若用 `switch (event.type)` 处理，需要覆盖新增的 `tool_result_pruned` / `compaction_start` / `compaction_end`；
2. **`RunResult`**：若依赖完整字段集，注意新增 `compacted?: boolean`；
3. **直接调用 `runner.run({...})`**：若想启用 compaction，需显式传 `compaction` 与 `contextWindowTokens`；不传则使用 `DEFAULT_COMPACTION_CONFIG`；
4. **测试断言**：用 `toEqual` 严格匹配 AgentEvent 的代码若失败，改用 `toMatchObject` 或补 `expect.objectContaining`；
5. **steering / followUp**：需要的话提供 `getSteeringMessages` / `getFollowUpMessages` reader；library 模式下若不需要 in-turn 注入，全部留空即可；
6. **Hook 消费方**：若想观察压缩，可注册 `before_compaction` / `after_compaction` hook；若仅想记录 metric，订阅 `compaction_*` event 也一样；
7. **ContextOverflowError 处理**：若调用方主动 catch `run()` 的异常，注意可能收到 `ContextOverflowError`（当重试用完仍失败时）。

---

## 6. 不变的部分

以下接口与行为在 v0.9 与 v1.0 之间保持一致：

- `AgentRunnerConfig` 三个字段（`llmClient` / `sessionManager` / `toolExecutor` / `onEvent`）；
- `RunParams` 已有字段（`sessionKey` / `message` / `model` / `systemPrompt` / `turnId` / `tools` / `maxTokens` / `maxLlmCalls` / `inTurnMessageMode`）；
- `RunResult` 已有字段（`text` / `content` / `stopReason` / `usage` / `toolRounds`）；
- 两层循环（外层 followUp / 内层 tool use）的整体结构；
- Session 持久化时序（user → assistant(tool_use) → toolResult → assistant(text)）；
- `error` 事件既 emit 又 throw 的行为；
- `stopReason` 取值（`'end_turn'` / `'max_llm_calls'` / `'error'` / `'aborted'` 等）；
- Hook 注册 API `on(hookName, handler, options)`；
- `before_tool_call` / `after_tool_call` 的语义与执行模型。
