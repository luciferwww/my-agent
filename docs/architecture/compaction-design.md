# 对话压缩（Compaction）设计规格文档

> 创建日期：2026-04-13  
> 参考：OpenClaw 压缩机制分析（详见 [openclaw-compaction-analysis.md](../analysis/openclaw/openclaw-compaction-analysis.md)）  
> 前置文档：[agent-runner-design.md](agent-runner-design.md)、[session-design.md](session-design.md)

---

## 1. 概述

对话压缩模块为 AgentRunner 提供上下文窗口管理能力，防止长对话超出 LLM 上下文窗口导致调用失败。

**职责**：
- Token 估算（发送 LLM 前预判上下文大小）
- Tool result 裁剪（不调 LLM，仅内存操作）
- 预判检测与路由（决定压缩策略）
- LLM 摘要压缩（调用 LLM 生成历史摘要）
- 压缩记录持久化（写入 Session JSONL）

**不属于本模块的职责**：
- Memory flush（当前 memory 系统是语义索引，非 agent 主动写入模式）
- 并发压缩队列 / Lane（单用户单会话场景）
- 多 agent 压缩协调
- 自适应分块比例（初期固定比例即可）

### 设计原则

1. **渐进式**：轻量操作优先（裁剪），重量操作兜底（LLM 摘要）
2. **安全配对**：tool_use / tool_result 永远不被拆散
3. **可追溯**：压缩记录写入 JSONL，摘要内容可审计
4. **透明降级**：摘要失败时有明确的 fallback 路径
5. **与现有架构对齐**：压缩逻辑放在 AgentRunner 层（session-design.md 已声明此边界）

---

## 2. 现状分析

### 2.1 当前问题

`AgentRunner.run()` 的消息加载流程（`src/agent-runner/AgentRunner.ts:49-61`）：

```typescript
const history = this.loadHistory(params.sessionKey);   // ← 加载全量历史
const messages: ChatMessage[] = [
  ...history,                                           // ← 无限增长
  { role: 'user', content: params.message },
];
```

`loadHistory()`（第 207-221 行）调用 `sessionManager.getMessages()` 返回**所有消息**，无任何截断或 token 检查。随着对话轮次增加，`messages` 数组无限膨胀，最终超出上下文窗口。

同样，tool 执行结果（第 141-162 行）也是直接原样存入，一次 `read_file` 返回大量内容就可能撑满上下文。

### 2.2 已有基础设施

| 已有 | 位置 | 状态 |
|------|------|------|
| `CompactionRecord` 类型 | `src/session/types.ts:49-54` | 已定义，未使用 |
| `SessionEntry.compactionCount` 字段 | `src/session/types.ts:17` | 已定义，从未递增 |
| `SessionEntry.totalTokens` 等字段 | `src/session/types.ts:13-15` | 已定义，从未更新 |
| `SessionManager.updateSession()` | `src/session/SessionManager.ts:124-135` | 可用于更新元数据 |
| `appendToTranscript()` | `src/session/transcript.ts:73-80` | 可用于写入压缩记录 |
| `resolveLinearPath()` 过滤非 message 类型 | `src/session/transcript.ts:49-68` | 已过滤 `type !== 'message'`，需扩展 |
| 树形 parentId 结构 | `src/session/types.ts:24-30` | 天然支持压缩分支 |
| `RunResult.usage` | `src/agent-runner/types.ts:47` | 已收集但未用于决策 |

---

## 3. 分层架构

三层渐进式设计，每层独立可用：

```
Layer 1: Tool Result 裁剪                    [不调 LLM，纯字符串操作]
  ↓ 裁剪后仍超限
Layer 2: 预判检测 + 路由                      [不调 LLM，token 估算]
  ↓ 判定需要压缩
Layer 3: LLM 摘要压缩                        [调 LLM，生成摘要替换旧消息]
```

### 在 AgentRunner.run() 中的插入点

```
run(params)
  │
  ├─ loadHistory() → 全量消息
  ├─ 保存用户消息到 session
  ├─ 构建 messages 数组
  │
  ├─ ★ [新增] Layer 1: pruneToolResults(messages)
  │     裁剪超大的 tool result，不改变持久化数据
  │
  ├─ ★ [新增] Layer 2: checkContextBudget(messages, system, config)
  │     估算 token，判断是否超限
  │     ├─ fits → 继续
  │     ├─ needs_compaction → 触发 Layer 3
  │     └─ overflow_after_compaction → 抛错
  │
  ├─ ★ [新增] Layer 3: compactHistory(sessionKey, messages, config)
  │     LLM 摘要 → 替换旧消息 → 持久化压缩记录
  │     → 用压缩后的 messages 继续
  │
  ├─ 内层循环：LLM 调用 + tool use
  │     ├─ ★ [新增] 每轮 tool result 返回后，执行 Layer 1 裁剪
  │     └─ ★ [新增] 每轮 LLM 调用前，执行 Layer 2 检查
  │
  └─ 返回结果
```

---

## 4. 类型系统

### 4.1 CompactionConfig（新增）

```typescript
// src/config/types.ts — 新增

/** 对话压缩配置 */
export interface CompactionConfig {
  /** 是否启用压缩 */
  enabled: boolean;
  /** 上下文窗口大小（tokens），应与模型实际窗口匹配 */
  contextWindowTokens: number;
  /** 预留 token 数（为新回复留出空间） */
  reserveTokens: number;
  /** 压缩后保留最近 N 个用户轮次的完整消息 */
  keepRecentTurns: number;
  /** Tool result 裁剪：单个结果的最大字符数 */
  toolResultMaxChars: number;
  /** Tool result 裁剪：保留头部字符数 */
  toolResultHeadChars: number;
  /** Tool result 裁剪：保留尾部字符数 */
  toolResultTailChars: number;
  /** 压缩超时（秒） */
  timeoutSeconds: number;
  /** 摘要生成的自定义指令（追加到默认指令后） */
  customInstructions?: string;
}
```

### 4.2 默认值

```typescript
// src/config/defaults.ts — 新增

compaction: {
  enabled: true,
  contextWindowTokens: 200_000,   // Claude 3.5 Sonnet
  reserveTokens: 20_000,          // 为新回复和 system prompt 留出空间
  keepRecentTurns: 3,             // 最近 3 轮用户消息不压缩
  toolResultMaxChars: 30_000,     // 超过此大小才裁剪
  toolResultHeadChars: 10_000,    // 保留头部 10K
  toolResultTailChars: 5_000,     // 保留尾部 5K
  timeoutSeconds: 300,            // 5 分钟超时
},
```

### 4.3 AgentDefaults 扩展

```typescript
// src/config/types.ts — 修改

export interface AgentDefaults {
  llm: LLMConfig;
  runner: RunnerConfig;
  memory: MemoryModuleConfig;
  prompt: PromptConfig;
  session: SessionConfig;
  tools: ToolsConfig;
  workspace: WorkspaceConfig;
  compaction: CompactionConfig;     // ← 新增
}
```

### 4.4 CompactionRecord 扩展

当前定义（`src/session/types.ts:49-54`）：

```typescript
export interface CompactionRecord extends TranscriptEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}
```

扩展为：

```typescript
export interface CompactionRecord extends TranscriptEntryBase {
  type: 'compaction';
  /** LLM 生成的历史摘要 */
  summary: string;
  /** 压缩后保留的第一条消息 ID */
  firstKeptEntryId: string;
  /** 压缩前的估算 token 数 */
  tokensBefore: number;
  /** 压缩后的估算 token 数 */
  tokensAfter: number;                // ← 新增
  /** 触��原因 */
  trigger: 'preemptive' | 'overflow' | 'manual';  // ← 新增
  /** 被丢弃的消息数量 */
  droppedMessages: number;            // ← 新增
}
```

### 4.5 RunParams 扩展

```typescript
// src/agent-runner/types.ts — 修改

export interface RunParams {
  // ... 现有字段 ...

  /** 压缩配置（由 RuntimeApp 传入） */
  compaction?: CompactionConfig;      // ← 新增
}
```

### 4.6 RunResult 扩展

```typescript
// src/agent-runner/types.ts — 修改

export interface RunResult {
  // ... 现有字段 ...

  /** 本次运行是否触发了压缩 */
  compacted?: boolean;                // ← 新增
  /** 压缩统计（仅在 compacted=true 时有值） */
  compactionStats?: {                 // ← 新增
    tokensBefore: number;
    tokensAfter: number;
    droppedMessages: number;
    trigger: 'preemptive' | 'overflow' | 'manual';
  };
}
```

### 4.7 AgentEvent 扩展

```typescript
// src/agent-runner/types.ts — 修改

export type AgentEvent =
  | { type: 'run_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'llm_call'; round: number }
  | { type: 'run_end'; result: RunResult }
  | { type: 'error'; error: Error }
  // ↓ 新增
  | { type: 'compaction_start'; trigger: 'preemptive' | 'overflow' | 'manual'; estimatedTokens: number }
  | { type: 'compaction_end'; tokensBefore: number; tokensAfter: number; droppedMessages: number }
  | { type: 'tool_result_pruned'; name: string; originalChars: number; prunedChars: number };
```

---

## 5. Token 估算

### 5.1 函数设计

新建文件 `src/agent-runner/token-estimation.ts`：

```typescript
/**
 * Token 估算工具。
 *
 * 使用 chars/4 启发式估算（对英文 80% 准确，对中文偏低但安全）。
 * 乘以 SAFETY_MARGIN 补偿估算误差。
 */

/** 安全边际：补偿 chars/4 对多字节字符、特殊 token 的低估 */
export const SAFETY_MARGIN = 1.2;

/** 估算单条消息的 token 数 */
export function estimateMessageTokens(message: ChatMessage): number;

/** 估算消息数组 + system prompt 的总 token 数 */
export function estimatePromptTokens(params: {
  messages: ChatMessage[];
  systemPrompt?: string;
}): number;
```

### 5.2 估算逻辑

```
estimatePromptTokens({ messages, systemPrompt })
  │
  ├─ systemPrompt → chars / 4
  ├─ 每条 message:
  │   ├─ content 为 string → chars / 4
  │   ├─ content 为 ContentBlock[]:
  │   │   ├─ text block → text.chars / 4
  │   │   ├─ tool_use block → JSON.stringify(input).chars / 4
  │   │   ├─ tool_result block → content.chars / 4
  │   │   └─ image block → 固定 2000 tokens（图片 token 估算）
  │   └─ 每条消息额外 +4 tokens（role/formatting 开销）
  │
  └─ 总和 × SAFETY_MARGIN(1.2)
```

---

## 6. Layer 1: Tool Result 裁剪

### 6.1 设计

新建文件 `src/agent-runner/tool-result-pruning.ts`：

```typescript
/**
 * Tool result 裁剪。
 *
 * 对超过 maxChars 的 tool result 内容，保留头部和尾部，中间用省略标记替代。
 * 纯字符串操作，不调用 LLM，不修改持久化数据，仅影响发给 LLM 的 messages。
 */
export function pruneToolResults(
  messages: ChatMessage[],
  config: Pick<CompactionConfig, 'toolResultMaxChars' | 'toolResultHeadChars' | 'toolResultTailChars'>,
  onPruned?: (info: { index: number; originalChars: number; prunedChars: number }) => void,
): ChatMessage[];
```

### 6.2 裁剪算法

对 messages 中每个 `role: 'user'` 且 content 包含 `tool_result` block 的消息：

```
对每个 tool_result block:
  originalChars = block.content.length
  
  if originalChars <= toolResultMaxChars:
    不裁剪
  else:
    head = block.content.slice(0, toolResultHeadChars)
    tail = block.content.slice(-toolResultTailChars)
    trimmed = head + "\n\n...\n\n" + tail
              + "\n\n[Tool result trimmed: kept first "
              + toolResultHeadChars + " and last " + toolResultTailChars
              + " of " + originalChars + " chars]"
    替换 block.content = trimmed
    触发 onPruned 回调
```

### 6.3 注意事项

- 返回**新的 messages 数组**，不修改原数组（immutable）
- 仅裁剪内存中的消息，**不修改 session 持久化数据**
- 图片 block 不裁剪（跳过 `type: 'image'` ）
- 发给 LLM 的 messages 中 tool_result 是 `role: 'user'` + `type: 'tool_result'`

---

## 7. Layer 2: 预判检测与路由

### 7.1 函数设计

新建文件 `src/agent-runner/context-budget.ts`：

```typescript
/**
 * 上下文预算检查。
 *
 * 在发送 LLM 前估算总 token，决定路由策略。
 */

export type ContextBudgetRoute =
  | 'fits'                      // 不需要任何处理
  | 'compact'                   // 需要 LLM 摘要压缩
  | 'overflow';                 // 压缩后也不够（异常情况）

export function checkContextBudget(params: {
  messages: ChatMessage[];
  systemPrompt?: string;
  config: CompactionConfig;
}): {
  route: ContextBudgetRoute;
  estimatedTokens: number;
  availableTokens: number;
  overflowTokens: number;
};
```

### 7.2 路由逻辑

```
checkContextBudget({ messages, systemPrompt, config })
  │
  ├─ estimatedTokens = estimatePromptTokens({ messages, systemPrompt })
  ├─ availableTokens = config.contextWindowTokens - config.reserveTokens
  ├─ overflowTokens  = max(0, estimatedTokens - availableTokens)
  │
  ├─ overflowTokens === 0
  │   └─ route = "fits"
  │
  ├─ overflowTokens > 0
  │   └─ route = "compact"
  │
  └─ 返回 { route, estimatedTokens, availableTokens, overflowTokens }
```

### 7.3 在 AgentRunner.run() 中的集成

```typescript
// AgentRunner.run() 内，构建 messages 之后：

// Layer 1: 裁剪 tool results
messages = pruneToolResults(messages, compaction, (info) => {
  this.emit({ type: 'tool_result_pruned', ... });
});

// Layer 2: 检查上下文预算
const budget = checkContextBudget({ messages, systemPrompt, config: compaction });

if (budget.route === 'compact') {
  // Layer 3: LLM 摘要压缩
  this.emit({ type: 'compaction_start', trigger: 'preemptive', estimatedTokens: budget.estimatedTokens });
  const compactResult = await this.compactHistory(sessionKey, messages, compaction);
  messages = compactResult.messages;
  this.emit({ type: 'compaction_end', ... });
}

// 继续正常的 LLM 调��循环...
```

### 7.4 内层循环中的检查

每轮 tool result 返回后、下一次 LLM 调用前，也需要执行 Layer 1 + Layer 2 检查：

```typescript
// 内层循环中，tool result push 到 messages 之后：
messages = pruneToolResults(messages, compaction);
const budget = checkContextBudget({ messages, systemPrompt, config: compaction });
if (budget.route === 'compact') {
  const compactResult = await this.compactHistory(sessionKey, messages, compaction);
  messages = compactResult.messages;
}
```

---

## 8. Layer 3: LLM 摘要压缩

### 8.1 文件结构

新建文件 `src/agent-runner/compaction.ts`：

```typescript
/**
 * 对话压缩核心逻辑。
 *
 * 将旧消息交给 LLM 生成摘要，用摘要替换旧消息，保留最近 N 轮完整消息。
 */

export interface CompactionResult {
  /** 压缩后的 messages 数组（摘要 + 保留的近期消息） */
  messages: ChatMessage[];
  /** 压缩统计 */
  stats: {
    tokensBefore: number;
    tokensAfter: number;
    droppedMessages: number;
    trigger: 'preemptive' | 'overflow' | 'manual';
  };
  /** 用于持久化的 CompactionRecord */
  record: CompactionRecord;
}

export async function compactMessages(params: {
  messages: ChatMessage[];
  config: CompactionConfig;
  llmClient: LLMClient;
  model: string;
  trigger: 'preemptive' | 'overflow' | 'manual';
}): Promise<CompactionResult>;
```

### 8.2 消息拆分：识别保留区和压缩区

```
messages = [msg0, msg1, msg2, ..., msgN-3, msgN-2, msgN-1, msgN]
            ├──────── 压缩区 ────────┤├─── 保留区（最近 N 轮）───┤
```

"轮次"的定义：一个 user 消息 + 紧随的所有 assistant/toolResult 消息。

拆分算法：

```
splitForCompaction(messages, keepRecentTurns):
  │
  ├─ 从末尾反向扫描，计数 user 消息数
  ├��� 找到第 keepRecentTurns 个 user 消息的位置 → splitIndex
  │
  ├─ 安全检查：splitIndex 处如果切在 assistant(tool_use) 之后、
  │   对应 toolResult 之前 → 向前移动到该 assistant 之前
  │   （保证 tool_use/tool_result 配对完整）
  │
  ├─ toCompress = messages[0..splitIndex)
  └─ toKeep     = messages[splitIndex..]
```

### 8.3 摘要生成

使用当前 `llmClient` 调用 LLM 生成摘要：

```typescript
async function generateSummary(params: {
  messages: ChatMessage[];
  llmClient: LLMClient;
  model: string;
  customInstructions?: string;
}): Promise<string>
```

摘要生成 prompt：

```
System: You are a conversation summarizer. Create a concise summary of the
following conversation between a user and an AI assistant.

MUST PRESERVE:
- Active tasks and their current status (in-progress, blocked, pending)
- The last thing the user requested and what was being done about it
- Decisions made and their rationale
- File paths, variable names, and code-related identifiers exactly as written
- TODOs, open questions, and constraints
- Any commitments or follow-ups promised

PRIORITIZE recent context over older history.
Write the summary in the primary language used in the conversation.
Do not translate or alter code, file paths, identifiers, or error messages.

{customInstructions}

User: <conversation>
{序列化 toCompress 中的消息}
</conversation>

Summarize this conversation.
```

### 8.4 两级降级

```
Level 1: 完整摘要
  调用 LLM 对压缩区消息生成摘要
  │
  ├─ 成功 → 使用摘要
  └─ 失败 ↓

Level 2: 兜底文本
  summary = "[Conversation summary unavailable. "
          + "Prior conversation contained {N} messages over {M} exchanges. "
          + "Recent context preserved below.]"
```

### 8.5 摘要注入

压缩后的 messages 数组：

```typescript
const compactedMessages: ChatMessage[] = [
  // 摘要作为第一条 user 消息
  {
    role: 'user',
    content: `[Previous conversation summary]\n\n${summary}\n\n[End of summary. The conversation continues below.]`,
  },
  // 保留区的完整消息
  ...toKeep,
];
```

### 8.6 完整压缩流程

```
compactMessages({ messages, config, llmClient, model, trigger })
  │
  ├─ tokensBefore = estimatePromptTokens({ messages })
  │
  ├─ splitForCompaction(messages, config.keepRecentTurns)
  │   → { toCompress, toKeep }
  │
  ├─ toCompress 为空（消息太少，无法压缩）？
  │   └─ 抛出 CompactionError("Not enough messages to compact")
  │
  ├─ generateSummary({ messages: toCompress, llmClient, model })
  │   ├─ 成功 → summary
  │   └─ 失败 → 兜底文本
  │
  ├─ 构建压缩后 messages = [summaryMessage, ...toKeep]
  │
  ├─ tokensAfter = estimatePromptTokens({ messages: compactedMessages })
  │
  ├─ 构建 CompactionRecord
  │
  └─ 返回 { messages, stats, record }
```

---

## 9. Session 集成

### 9.1 CompactionRecord 写入

压缩完成后，AgentRunner 需要：

1. 将 `CompactionRecord` 写入 JSONL
2. 更新 `SessionEntry` 元数据

由于 SessionManager 的职责是存储，压缩记录的写入通过已有接口完成：

```typescript
// 在 AgentRunner 中，压缩完成后：

// 1. 追加 CompactionRecord 到 JSONL（复用 appendToTranscript）
await appendToTranscript(transcriptPath, compactResult.record);

// 2. 更新 SessionEntry 元数据
await sessionManager.updateSession(sessionKey, {
  compactionCount: (currentEntry.compactionCount ?? 0) + 1,
  totalTokens: compactResult.stats.tokensAfter,
});
```

### 9.2 SessionManager 扩展

需要为 SessionManager 添加两个方法供 AgentRunner 调用：

```typescript
// src/session/SessionManager.ts — 新增

/** 追加压缩记录到 JSONL（不影响 leafId） */
async appendCompactionRecord(
  key: string,
  record: CompactionRecord,
): Promise<void>;

/** 获取最近一次压缩摘要（用于 loadHistory 时注入） */
getLastCompactionSummary(key: string): string | null;
```

### 9.3 loadHistory 中的摘要注入

`AgentRunner.loadHistory()` 需要改造，当检测到 session 有压缩记录时，在历史消息前注入摘要：

```typescript
// 改造后的 loadHistory
private loadHistory(sessionKey: string): ChatMessage[] {
  const records = this.sessionManager.getMessages(sessionKey);
  const messages = records.map(/* 现有转换逻辑 */);

  // 检查是否有压缩摘要
  const summary = this.sessionManager.getLastCompactionSummary(sessionKey);
  if (summary) {
    // 在最前面插入摘要消息
    messages.unshift({
      role: 'user',
      content: `[Previous conversation summary]\n\n${summary}\n\n[End of summary]`,
    });
  }

  return messages;
}
```

### 9.4 resolveLinearPath 扩展

当前 `resolveLinearPath()`（`src/session/transcript.ts:49-68`）只返回 `type === 'message'` 的记录。需要扩展以支持 compaction 记录的感知：

```typescript
// 方案：不修改 resolveLinearPath，保持只返回 message
// 新增独立函数：
export function findLastCompaction(state: TranscriptState): CompactionRecord | null {
  // 遍历 byId，找到最后一条 type === 'compaction' 的记录
  let last: CompactionRecord | null = null;
  for (const entry of state.byId.values()) {
    if (entry.type === 'compaction') {
      if (!last || entry.timestamp > last.timestamp) {
        last = entry as CompactionRecord;
      }
    }
  }
  return last;
}
```

### 9.5 压缩后的消息边界

压缩后，JSONL 文件中的消息结构：

```jsonl
{"type":"session","id":"s1","parentId":null,...}
{"type":"message","id":"m1","parentId":"s1",...,"message":{"role":"user","content":"早期消息1"}}
{"type":"message","id":"m2","parentId":"m1",...,"message":{"role":"assistant","content":"早期回复1"}}
...
{"type":"message","id":"m20","parentId":"m19",...,"message":{"role":"assistant","content":"较旧回复"}}
{"type":"compaction","id":"c1","parentId":"m20","summary":"...摘要...","firstKeptEntryId":"m21","tokensBefore":150000,"tokensAfter":30000,"trigger":"preemptive","droppedMessages":20}
{"type":"message","id":"m21","parentId":"m20",...,"message":{"role":"user","content":"近期消息1"}}
...（后续消息继续正常追加）
```

关键点：
- CompactionRecord 插入在压缩区末尾和保留区开头之间
- `firstKeptEntryId` 指向保留区的第一条消息
- **不删除旧消息**——它们仍在 JSONL 中，但 `getMessages()` 返回的线性路径中，AgentRunner 只使��� `firstKeptEntryId` 之后的消息 + 摘要

### 9.6 压缩后 getMessages 的行为调整

当 session 有压缩记录后，`getMessages()` 仍返回从 leafId 到根的全部 message。真正的"截断"发生在 `loadHistory()` 中：

```
方案 A（推荐）：getMessages 不变，loadHistory 根据压缩记���截断
  - getMessages() 仍返回全量 message records
  - loadHistory() 检查 lastCompaction，只取 firstKeptEntryId 之后的消息
  - 在最前面注入摘要

方案 B：getMessages 感知压缩记录
  - 修改 resolveLinearPath，遇到 compaction 记录后跳过更早的消息
  - 更复杂，与"session 只负责存储"的原则冲突
```

采用**方案 A**，保持 SessionManager 的纯存储职责。

---

## 10. Overflow 错误处理

除了预判式压缩，还需要处理 LLM 返回的溢出错误（作为第二道防线）：

### 10.1 错误检测

在 `AgentRunner.callLLMStream()` 中检测溢出错误：

```typescript
function isContextOverflowError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('request_too_large') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context length')
  );
}
```

### 10.2 错误恢复流程

```
LLM 调用失败
  │
  ├─ isContextOverflowError(error)?
  │   ├─ 否 → 抛出原始错误
  │   └─ 是 ↓
  │
  ├─ 已经压缩过了（本轮已触发过压缩）？
  │   └─ 是 → 抛出 CompactionError("Context still overflows after compaction")
  │
  └─ 触发 Layer 3 压缩（trigger = 'overflow'）
      → 压缩后重新调用 LLM
```

---

## 11. 配置集成

### 11.1 config/types.ts 修改

在 `AgentDefaults` 中添加 `compaction` 字段（见第 4.3 节）。

### 11.2 config/defaults.ts 修改

添加默认值（见第 4.2 节）。

### 11.3 RuntimeApp 传递

`RuntimeApp.runTurnInternal()` 在调用 `AgentRunner.run()` 时传入压缩配置：

```typescript
// src/runtime/RuntimeApp.ts — runTurnInternal() 修改

const result = await agentRunner.run({
  sessionKey,
  message: builtUserPrompt.text,
  model,
  systemPrompt,
  tools: toolBundle.llmDefinitions,
  maxTokens: config.llm.maxTokens,
  maxToolRounds: config.runner.maxToolRounds,
  maxFollowUpRounds: config.runner.maxFollowUpRounds,
  compaction: config.compaction,      // ← 新增
});
```

---

## 12. 实施步骤

### Phase 1: 基础防护（Token 估算 + Tool Result 裁剪 + 预判检测）

- [ ] `src/agent-runner/token-estimation.ts`
  - [ ] `estimateMessageTokens()`
  - [ ] `estimatePromptTokens()`
  - [ ] 单元测试
- [ ] `src/agent-runner/tool-result-pruning.ts`
  - [ ] `pruneToolResults()`
  - [ ] 单元测试
- [ ] `src/agent-runner/context-budget.ts`
  - [ ] `checkContextBudget()`
  - [ ] 单元测试
- [ ] `src/config/types.ts`
  - [ ] 新增 `CompactionConfig` 接口
  - [ ] `AgentDefaults` 添加 `compaction` 字段
- [ ] `src/config/defaults.ts`
  - [ ] 添加 `compaction` 默认值
- [ ] `src/agent-runner/types.ts`
  - [ ] `AgentEvent` 新增 `tool_result_pruned` 事件
- [ ] `src/agent-runner/AgentRunner.ts`
  - [ ] `run()` 中 LLM 调用前插入 `pruneToolResults()` + `checkContextBudget()`
  - [ ] 内层循环每轮 tool result 后也执行检查
  - [ ] `checkContextBudget` 返回 `compact` 时暂时抛出明确错误（Phase 2 替换为压缩）

### Phase 2: LLM 摘要压缩

- [ ] `src/agent-runner/compaction.ts`
  - [ ] `splitForCompaction()` — 消息拆分（tool_use/tool_result 配对保护）
  - [ ] `generateSummary()` — LLM 摘要生成 + 两级降级
  - [ ] `compactMessages()` — 完整压缩流程
  - [ ] 单元测试
- [ ] `src/session/types.ts`
  - [ ] `CompactionRecord` 扩展字段（`tokensAfter`, `trigger`, `droppedMessages`）
- [ ] `src/session/transcript.ts`
  - [ ] 新增 `findLastCompaction()`
- [ ] `src/session/SessionManager.ts`
  - [ ] 新增 `appendCompactionRecord()`
  - [ ] 新增 `getLastCompactionSummary()`
- [ ] `src/agent-runner/AgentRunner.ts`
  - [ ] 新增 `compactHistory()` 私有方法
  - [ ] `loadHistory()` 改造：感知压缩记录，注入摘要
  - [ ] `checkContextBudget` 返回 `compact` 时触发压缩（替代 Phase 1 的抛错）
  - [ ] 压缩完成后更新 SessionEntry 元数据
- [ ] `src/agent-runner/types.ts`
  - [ ] `AgentEvent` 新增 `compaction_start` / `compaction_end`
  - [ ] `RunParams` 添加 `compaction` 字段
  - [ ] `RunResult` 添加 `compacted` / `compactionStats`
- [ ] `src/runtime/RuntimeApp.ts`
  - [ ] `runTurnInternal()` 传入 `compaction` 配置

### Phase 3: 增强特性

- [ ] Overflow 错误检测与自动恢复
  - [ ] `isContextOverflowError()` 错误分类
  - [ ] `callLLMStream()` 捕获溢出错误 → 触发压缩 → 重试
  - [ ] 防止无限重试（已压缩过则抛错）
- [ ] 级联重试
  - [ ] 压缩后仍溢出 → 减少 `keepRecentTurns` 再次压缩（最低保留 1 轮）
- [ ] 压缩指标上报
  - [ ] `RuntimeApp` 的 `onEvent` 转发压缩事件
  - [ ] `getState()` 返回中包含最近压缩统计

---

## 13. 测试计划

### 13.1 Token 估算

| 测试用例 | 预期行为 |
|---------|---------|
| 纯文本消息估算 | chars/4 × SAFETY_MARGIN |
| 包含 tool_use 的 assistant 消息 | JSON.stringify(input) 计入 |
| 包含 tool_result 的 user 消息 | content 字符数计入 |
| 包含图片的消息 | 固定 2000 tokens |
| 空消息数组 | 返回 0 |
| 含 system prompt | system prompt 的 chars 计入 |

### 13.2 Tool Result 裁剪

| 测试用例 | 预期行为 |
|---------|---------|
| 短 tool result（<= maxChars） | 不裁剪，原样返回 |
| 长 tool result（> maxChars） | 保留头尾 + 省略标记 + 裁剪说明 |
| 多个 tool result，部分超限 | 只裁剪超限的，其余不变 |
| 不含 tool result 的消息 | 原样返回 |
| 不修改原数组 | 原始 messages 不变 |
| onPruned 回调 | 每次裁剪都触发，传入正确的字符数信息 |

### 13.3 预判检测

| 测试用例 | 预期行为 |
|---------|---------|
| token < available | route = "fits" |
| token > available | route = "compact" |
| 临界值（恰好等于 available） | route = "fits" |
| 极端情况（available <= 0） | route = "compact" |

### 13.4 消息拆分

| 测试用例 | 预期行为 |
|---------|---------|
| keepRecentTurns=3，消息足够多 | 保留最近 3 个 user 轮次 + 其后的 assistant/toolResult |
| keepRecentTurns=3，消息不足 3 轮 | 不压缩（toCompress 为空） |
| tool_use + tool_result 在边界上 | 配对不被拆散，向前移动 splitIndex |
| 只有 user/assistant 消息（无 tool） | 正常拆分 |

### 13.5 LLM 摘要压缩（集成测试）

| 测试用例 | 预期行为 |
|---------|---------|
| 正常压缩 | 旧消息被摘要替换，近期消息保留，压缩记录写入 JSONL |
| LLM 摘要失败 | 降级到兜底文本，不阻塞对话 |
| 压缩后 token 仍超限 | 抛出 CompactionError |
| 多次压缩同一 session | compactionCount 递增，每次有独立的 CompactionRecord |
| 压缩后再加载历史 | loadHistory 注入最近摘要 + 保留区消息 |

### 13.6 Overflow 错误恢复

| 测试用例 | 预期行为 |
|---------|---------|
| LLM 返回 context_length_exceeded | 自动压缩 + 重试 |
| LLM 返回其他错误 | 正常抛出，不触发压缩 |
| 压缩后重试仍然失败 | 抛出 CompactionError（不无限重试） |

### 13.7 端到端测试（test-runtime-app.ts）

| 测试场景 | 验证方式 |
|---------|---------|
| 长对话不崩溃 | 用 mock LLM 生成大量轮次，验证不抛出溢出错误 |
| 压缩后历史连续 | 压缩后第 N+1 轮 LLM 能"记住"摘要中的信息 |
| JSONL 压缩记录 | 读取 JSONL 文件，验证有 type=compaction 记录 |
| SessionEntry 更新 | 读取 sessions.json，验证 compactionCount > 0 |

---

## 14. 文件变更清单

### 新建文件

| 文件 | 说明 |
|------|------|
| `src/agent-runner/token-estimation.ts` | Token 估算工具 |
| `src/agent-runner/tool-result-pruning.ts` | Tool result 裁剪 |
| `src/agent-runner/context-budget.ts` | 上下文预算检查 |
| `src/agent-runner/compaction.ts` | LLM 摘要压缩核心 |
| `src/agent-runner/token-estimation.test.ts` | 单元测试 |
| `src/agent-runner/tool-result-pruning.test.ts` | 单元测试 |
| `src/agent-runner/context-budget.test.ts` | 单元测试 |
| `src/agent-runner/compaction.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/config/types.ts` | 新增 `CompactionConfig`，`AgentDefaults` 添加 `compaction` |
| `src/config/defaults.ts` | 添加 `compaction` 默认值 |
| `src/session/types.ts` | `CompactionRecord` 扩展字段 |
| `src/session/transcript.ts` | 新增 `findLastCompaction()` |
| `src/session/SessionManager.ts` | 新增 `appendCompactionRecord()`、`getLastCompactionSummary()` |
| `src/agent-runner/types.ts` | `RunParams`/`RunResult`/`AgentEvent` 扩展 |
| `src/agent-runner/AgentRunner.ts` | 集成三层压缩逻辑 |
| `src/runtime/RuntimeApp.ts` | 传入 `compaction` 配置 |
