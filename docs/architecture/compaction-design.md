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
Layer 1: Tool Result 裁剪（per-result）        [不调 LLM，纯字符串操作]
  ↓ 裁剪后仍超限
Layer 2: 预判检测 + 路由                       [不调 LLM，token 估算]
  ├─ truncate_tool_results_only → Layer 1.5: Tool Result 聚合裁剪  [不调 LLM]
  └─ compact → Layer 3: LLM 摘要压缩          [调 LLM，生成摘要替换旧消息]
```

### 在 AgentRunner.run() 中的插入点

```
run(params)  [外层 retry 循环，最多 MAX_COMPACTION_RETRIES 次]
  │
  ├─ catch ContextOverflowError
  │     ├─ compactHistory(sessionKey, ...)    ← 压缩 session
  │     ├─ compactionAttempts++
  │     └─ retry（重新执行 runAttempt）
  │
  └─ runAttempt(params)
       │
       ├─ loadHistory() → 全量历史消息
       ├─ 保存用户消息到 session
       ├─ messages = [...history]             ← 不含当前用户消息
       │
       ├─ ★ [新增] Layer 1: pruneToolResults(messages)
       │     裁剪超大的 tool result（per-result），不改变持久化数据
       │
       ├─ ★ [新增] Layer 2: checkContextBudget(messages, systemPrompt, currentPrompt)
       │     估算 token（历史、systemPrompt、currentPrompt 分别传入），判断是否超限
       │     ├─ fits → 直接继续
       │     ├─ truncate_tool_results_only
       │     │     └─ Layer 1.5: pruneToolResultsAggregate(messages)
       │     │           更激进地裁剪，将所有 tool result 总量压入聚合预算
       │     │           → 裁剪后直接继续，无需调 LLM
       │     └─ compact → throw ContextOverflowError → 外层 retry
       │
       ├─ ★ [新增] messages = [...messages, currentUserMessage]
       │     检查通过后才 append 当前用户消息
       │
       ├─ 内层循环：LLM 调用 + tool use
       │     ├─ ★ [新增] 每轮 tool result 后，执行 Layer 1 裁剪
       │     ├─ ★ [新增] 每轮 tool result 后，执行 90% 阈值检查
       │     │     └─ 超限 → throw ContextOverflowError → 外层 retry
       │     └─ LLM API 返回 context overflow 错误
       │           └─ throw ContextOverflowError → 外层 retry
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
  /** 预留 token 数（仅为模型输出留出空间；currentPrompt 已显式计入估算） */
  reserveTokens: number;
  /** 压缩后保留最近 N 个用户轮次的完整消息 */
  keepRecentTurns: number;
  /**
   * 单条 tool result 最大占 context window 的比例。
   * 运行时计算：maxChars = contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare
   * 其中 TOOL_RESULT_CHARS_PER_TOKEN = 2（tool result 比普通文本更密集）。
   * 例：200k 窗口 × 2 × 0.5 = 200,000 字符；32k 窗口 × 2 × 0.5 = 32,000 字符。
   */
  toolResultContextShare: number;
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

> 注意：上下文窗口大小（`contextWindowTokens`）定义在 `LLMConfig` 中，不在 `CompactionConfig` 里。
> 压缩逻辑从调用方接收 `config.llm.contextWindowTokens`，默认值 200,000 适用于 Claude 3.5 Sonnet / Claude 4 系列。

### 4.2 默认值

```typescript
// src/config/defaults.ts — 新增

compaction: {
  enabled: true,
  reserveTokens: 20_000,          // 仅覆盖模型输出预留量（currentPrompt 已显式计入估算）
  keepRecentTurns: 3,             // 最近 3 轮用户消息不压缩
  toolResultContextShare: 0.5,    // 单条 tool result 最大占 context window 的 50%
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
  /** 触发原因 */
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
  /** 模型上下文窗口大小（由 RuntimeApp 从 config.llm.contextWindowTokens 传入） */
  contextWindowTokens?: number;       // ← 新增
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

/** 估算消息数组 + system prompt + 当前用户消息的总 token 数 */
export function estimatePromptTokens(params: {
  messages: ChatMessage[];
  systemPrompt?: string;
  /** 当前用户消息字符串，单独计入，不纳入 messages（不会被压缩） */
  currentPrompt?: string;
}): number;
```

### 5.2 估算逻辑

```
estimatePromptTokens({ messages, systemPrompt, currentPrompt })
  │
  ├─ systemPrompt → chars / 4
  ├─ currentPrompt → chars / 4 + 4 tokens（消息开销，单独计入）
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
 * 对超过动态阈值的 tool result 内容，保留头部和尾部，中间用省略标记替代。
 * 阈值由 contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare 计算得出。
 * 纯字符串操作，不调用 LLM，不修改持久化数据，仅影响发给 LLM 的 messages。
 */

/** tool result 每 token 对应字符数（比普通文本更保守） */
export const TOOL_RESULT_CHARS_PER_TOKEN = 2;

export function pruneToolResults(
  messages: ChatMessage[],
  config: Pick<CompactionConfig, 'toolResultContextShare' | 'toolResultHeadChars' | 'toolResultTailChars'>,
  contextWindowTokens: number,
  onPruned?: (info: { index: number; originalChars: number; prunedChars: number }) => void,
): ChatMessage[];
```

### 6.2 裁剪算法

对 messages 中每个 `role: 'user'` 且 content 包含 `tool_result` block 的消息：

```
// 运行时计算动态阈值
maxChars = contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare
         = contextWindowTokens × 2 × 0.5
         = contextWindowTokens
// 例：200k 窗口 → 200,000 字符；32k 窗口 → 32,000 字符

对每个 tool_result block:
  originalChars = block.content.length
  
  if originalChars <= maxChars:
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

### 6.4 Layer 1.5: 聚合裁剪（truncate_tool_results_only 路由专用）

当 Layer 2 返回 `truncate_tool_results_only` 时，执行更激进的裁剪，使所有 tool result 的**总字符数**落入聚合预算内。

```typescript
/**
 * tool result 聚合预算份额。
 * 聚合预算 = contextWindowTokens × CHARS_PER_TOKEN(4) × AGGREGATE_TOOL_RESULT_CONTEXT_SHARE
 *          = contextWindowTokens × 1.2 chars
 * 例：200k 窗口 → 240,000 字符 = 60,000 tokens = 30% 的上下文给所有 tool result
 */
export const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * 聚合裁剪：将所有 tool result 总量压入聚合预算。
 *
 * context-budget.ts 的 estimateToolResultReductionPotential() import 本文件的
 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE，两处使用同一常量，保证估算与实际裁剪一致。
 *
 * 每条 result 按当前大小比例分配预算，但不裁剪到低于最小保留量
 * (toolResultHeadChars + toolResultTailChars)。
 * 返回新的 messages 数组（immutable）。
 */
export function pruneToolResultsAggregate(
  messages: ChatMessage[],
  contextWindowTokens: number,
  config: Pick<CompactionConfig, 'toolResultHeadChars' | 'toolResultTailChars'>,
): ChatMessage[];
```

裁剪算法（`CHARS_PER_TOKEN = 4` 为路由层常量，由 context-budget.ts 定义）：

```
aggregateBudgetChars = contextWindowTokens × 4 × AGGREGATE_TOOL_RESULT_CONTEXT_SHARE
minKeepChars         = config.toolResultHeadChars + config.toolResultTailChars

1. 统计所有 tool result 的 totalChars
2. 如果 totalChars <= aggregateBudgetChars，直接返回原数组（无需裁剪）
3. 对每条 tool result 按比例分配预算：
     perResultTarget = max(
       floor(aggregateBudgetChars × (result.length / totalChars)),  // 按比例分配
       minKeepChars                                                   // 不低于最小保留量
     )
     如果 result.length > perResultTarget → 裁剪（同 pruneToolResults 的头尾格式）
4. 返回修改后的新数组
```

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

// 路由数学用常量（仅在本文件内部使用）
const CHARS_PER_TOKEN = 4;               // 通用文本估算：chars / 4 ≈ tokens
const TRUNCATION_BUFFER_TOKENS = 512;    // 路由阈值安全冗余

// 从 tool-result-pruning.ts import（两处使用同一常量，避免分歧）
import { AGGREGATE_TOOL_RESULT_CONTEXT_SHARE } from './tool-result-pruning.js';

export type ContextBudgetRoute =
  | 'fits'                        // 不需要任何处理
  | 'truncate_tool_results_only'  // 更激进裁剪 tool result 即可解决溢出，无需 LLM
  | 'compact';                    // 需要 LLM 摘要压缩

export interface ContextBudgetResult {
  route: ContextBudgetRoute;
  estimatedTokens: number;
  availableTokens: number;
  overflowTokens: number;
  /** 聚合裁剪可节省的字符数（estimateToolResultReductionPotential 的计算结果） */
  reducibleChars: number;
}

export function checkContextBudget(params: {
  /** 历史消息（不含当前用户消息，已经过 Layer 1 裁剪） */
  messages: ChatMessage[];
  systemPrompt?: string;
  /** 当前用户消息字符串，独立传入，显式计入 token 估算，不会被压缩 */
  currentPrompt?: string;
  /** 由调用方从 config.llm.contextWindowTokens 传入 */
  contextWindowTokens: number;
  config: Pick<CompactionConfig,
    'reserveTokens' | 'toolResultHeadChars' | 'toolResultTailChars'>;
}): ContextBudgetResult;
```

### 7.2 路由逻辑

> **设计说明**：`messages` 传入时不含当前用户消息；`currentPrompt` 作为独立字符串参数显式传入，单独计入 token 估算。
> `reserveTokens`（默认 20,000）仅覆盖模型输出预留量，不再代理当前用户消息的体积。
> 这样设计的原因：压缩/裁剪只操作历史 `messages`，`currentPrompt` 永远不会被压缩，职责边界清晰。

```
checkContextBudget({ messages, systemPrompt, currentPrompt, contextWindowTokens, config })
  │
  ├─ estimatedTokens = estimatePromptTokens({ messages, systemPrompt, currentPrompt })
  │                    （历史 + systemPrompt + currentPrompt）
  ├─ availableTokens = contextWindowTokens - config.reserveTokens
  ├─ overflowTokens  = max(0, estimatedTokens - availableTokens)
  │
  ├─ overflowTokens === 0
  │   └─ route = "fits"，reducibleChars = 0
  │
  └─ overflowTokens > 0
      │
      ├─ reducibleChars = estimateToolResultReductionPotential(
      │     messages, contextWindowTokens,
      │     config.toolResultHeadChars, config.toolResultTailChars
      │   )
      │   │
      │   │  aggregateBudgetChars = contextWindowTokens × CHARS_PER_TOKEN
      │   │                        × AGGREGATE_TOOL_RESULT_CONTEXT_SHARE
      │   │  minKeepChars = config.toolResultHeadChars + config.toolResultTailChars
      │   │  totalToolResultChars = 所有 tool_result block 的 content.length 之和
      │   │
      │   │  // 不能裁剪低于最小保留量的部分
      │   │  maxSaveablePerResult = max(0, result.length - minKeepChars)
      │   │  totalMaxSaveable     = sum(maxSaveablePerResult for all results)
      │   │
      │   └─ reducibleChars = min(
      │         max(0, totalToolResultChars - aggregateBudgetChars),  // 聚合预算约束
      │         totalMaxSaveable                                       // 最小保留量约束
      │       )
      │
      ├─ truncateOnlyThreshold = max(
      │     overflowTokens × CHARS_PER_TOKEN + TRUNCATION_BUFFER_TOKENS × CHARS_PER_TOKEN,
      │     ceil(overflowTokens × CHARS_PER_TOKEN × 1.5)
      │   )
      │   （CHARS_PER_TOKEN=4，TRUNCATION_BUFFER_TOKENS=512，阈值含 50% 安全冗余）
      │
      ├─ reducibleChars >= truncateOnlyThreshold
      │   └─ route = "truncate_tool_results_only"（聚合裁剪足以覆盖溢出，无需 LLM）
      │
      └─ otherwise
          └─ route = "compact"（需要 LLM 摘要压缩，throw ContextOverflowError）
```

### 7.3 在 AgentRunner.run() 中的集成

```typescript
// AgentRunner.run() 内：
const contextWindowTokens = params.contextWindowTokens ?? 200_000;

// messages 仅含历史，当前用户消息暂不 append
const messages = [...this.loadHistory(params.sessionKey)];

// Layer 1: per-result 裁剪（只操作历史，不会触碰当前消息）
messages = pruneToolResults(messages, compaction, contextWindowTokens, (info) => {
  this.emit({ type: 'tool_result_pruned', ... });
});

// Layer 2: 检查上下文预算
const budget = checkContextBudget({
  messages,
  systemPrompt,
  currentPrompt: params.message,  // 单独传入，不合入 messages，不会被压缩
  contextWindowTokens,
  config: compaction,   // Pick: reserveTokens + toolResultHeadChars + toolResultTailChars
});

if (budget.route === 'truncate_tool_results_only') {
  // Layer 1.5: 聚合裁剪（比 Layer 1 更激进，但无需 LLM）
  messages = pruneToolResultsAggregate(messages, contextWindowTokens, compaction);
  // 裁剪后直接继续，不调 LLM
} else if (budget.route === 'compact') {
  // Layer 3: 需要 LLM 摘要压缩，交由外层 retry 循环处理
  throw new ContextOverflowError(
    `Preemptive compaction required: estimated ${budget.estimatedTokens} tokens `
    + `exceeds budget ${budget.availableTokens} tokens`,
  );
}

// 压缩/裁剪完成后，将当前用户消息 append 进 messages
messages.push({ role: 'user', content: params.message });

// 继续正常的 LLM 调用循环...
```

### 7.4 内层循环中的检查

内层循环里不做就地压缩，而是通过抛出 `ContextOverflowError` 交由外层 retry 循环处理。有两个触发点：

**触发点 1 — 90% 阈值检查（主动，避免 API 报错）**

```typescript
// 内层循环中，tool result push 到 messages 之后：
messages = pruneToolResults(messages, compaction, contextWindowTokens);

const estimated = estimatePromptTokens({ messages, systemPrompt });
if (estimated > params.contextWindowTokens * 0.9) {
  throw new ContextOverflowError('Context exceeds 90% threshold during tool loop');
}
```

**触发点 2 — LLM API 报错（被动兜底）**

```typescript
// LLM 调用失败时：
if (isContextOverflowError(error)) {
  throw new ContextOverflowError(error.message);
}
```

两条路径都抛出同一个 `ContextOverflowError`，外层 retry 循环统一处理。

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

需要为 SessionManager 添加以下方法和接口供 AgentRunner / bootstrap 调用：

```typescript
// src/session/SessionManager.ts — 新增

/**
 * 写盘时硬上限裁剪选项。
 * toolResultHeadChars + toolResultTailChars 同时设置才生效。
 * Bootstrap 从 resolvedConfig.compaction 传入。
 */
export interface SessionManagerOptions {
  toolResultHeadChars?: number;
  toolResultTailChars?: number;
}

/** 追加压缩记录到 JSONL（不影响 leafId） */
async appendCompactionRecord(
  key: string,
  record: Omit<CompactionRecord, 'parentId' | 'firstKeptEntryId'>,
  firstKeptEntryId: string,
): Promise<void>;

/** 获取最近一次压缩摘要（用于 loadHistory 时注入） */
getLastCompactionSummary(key: string): string | null;

/** 获取最近一次压缩记录完整信息（loadHistory 用于截断历史） */
getLastCompactionRecord(key: string): CompactionRecord | null;
```

**写盘截断（Gap 2 对齐 OpenClaw）**：

`appendMessage()` 写入 JSONL 之前，对 `role === 'toolResult'` 的消息执行硬上限裁剪，裁剪配置来自构造选项：

```typescript
// appendMessage() 内部
const persistedMessage = message.role === 'toolResult'
  ? { ...message, content: this.capToolResults(message.content) }
  : message;
// 写盘后磁盘上就是截断数据，后续 loadHistory() 无需重复裁剪
```

Bootstrap 注入：

```typescript
// src/runtime/bootstrap.ts
const sessionManager = deps.createSessionManager(options.workspaceDir, {
  toolResultHeadChars: resolvedConfig.compaction.toolResultHeadChars,
  toolResultTailChars: resolvedConfig.compaction.toolResultTailChars,
});
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

所有 overflow 情况（外层预判、内层 90% 检查、LLM API 报错）统一抛出 `ContextOverflowError`，由外层 retry 循环集中处理。

### 10.1 ContextOverflowError

```typescript
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}
```

### 10.2 LLM API 错误检测

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

### 10.3 外层 retry 循环

```typescript
// AgentRunner.run() 外层结构

const MAX_COMPACTION_RETRIES = 3;
let compactionAttempts = 0;

while (true) {
  try {
    return await this.runAttempt(params);
  } catch (error) {
    if (error instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
      // 压缩 session，重新执行整个 attempt
      await this.compactHistory(params.sessionKey, { trigger: 'overflow' });
      compactionAttempts++;
      // continue → 重新执行 runAttempt，loadHistory 会加载压缩后的 session
    } else {
      throw error;
    }
  }
}
```

### 10.4 三条触发路径

```
外层 checkContextBudget 超限
  └─ throw ContextOverflowError
       ↓
内层 90% 阈值检查超限
  └─ throw ContextOverflowError
       ↓
内层 LLM API 返回 context overflow
  └─ isContextOverflowError() → throw ContextOverflowError
       ↓
       外层 retry 循环捕获
         ├─ compactionAttempts < MAX_COMPACTION_RETRIES
         │   → compactHistory() → retry runAttempt
         └─ 超过限制 → 抛出原始错误
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
  compaction: config.compaction,                        // ← 新增
  contextWindowTokens: config.llm.contextWindowTokens,  // ← 新增
});
```

---

## 12. 实施步骤

### Phase 1: 基础防护（Token 估算 + Tool Result 裁剪 + 预判检测）

- [x] `src/agent-runner/token-estimation.ts`
  - [x] `estimateMessageTokens()`
  - [x] `estimatePromptTokens()`
  - [x] 单元测试
- [x] `src/agent-runner/tool-result-pruning.ts`
  - [x] `pruneToolResults()` — per-result 裁剪
  - [x] `pruneToolResultsAggregate()` — 聚合裁剪（truncate_tool_results_only 专用）
  - [x] 单元测试
- [x] `src/agent-runner/context-budget.ts`
  - [x] `checkContextBudget()` — 3 路路由：fits / truncate_tool_results_only / compact
  - [x] `estimateToolResultReductionPotential()` — 内部函数，估算聚合裁剪可节省的字符数
  - [x] 单元测试
- [x] `src/config/types.ts`
  - [x] 新增 `CompactionConfig` 接口
  - [x] `AgentDefaults` 添加 `compaction` 字段
  - [x] `LLMConfig` 新增 `contextWindowTokens`
- [x] `src/config/defaults.ts`
  - [x] 添加 `compaction` 默认值
  - [x] `llm` 新增 `contextWindowTokens: 200_000`
- [x] `src/agent-runner/types.ts`
  - [x] `RunParams` 新增 `compaction?: CompactionConfig`
  - [x] `RunParams` 新增 `contextWindowTokens?: number`
  - [x] `RunResult` 新增 `compacted` / `compactionStats`
  - [x] `AgentEvent` 新增 `tool_result_pruned` 事件
  - [x] `AgentEvent` 新增 `compaction_start` / `compaction_end`（Phase 2）
- [x] `src/agent-runner/AgentRunner.ts`
  - [x] `run()` 中 LLM 调用前插入 `pruneToolResults()` + `checkContextBudget()`（含 `truncate_tool_results_only` 路由处理）
  - [x] 内层循环每轮 tool result 后执行 90% 阈值检查（throw `ContextOverflowError`）

### Phase 2: LLM 摘要压缩 + Overflow 处理

- [x] `src/agent-runner/compaction.ts`
  - [x] `splitForCompaction()` — 消息拆分（tool_use/tool_result 配对保护）
  - [x] `generateSummary()` — LLM 摘要生成 + 两级降级
  - [x] `compactMessages()` — 完整压缩流程
  - [x] 单元测试
- [x] `src/agent-runner/errors.ts`
  - [x] `ContextOverflowError` 类
  - [x] `isContextOverflowError()` — LLM API 溢出错误分类
- [x] `src/session/types.ts`
  - [x] `CompactionRecord` 扩展字段（`tokensAfter`, `trigger`, `droppedMessages`）
- [x] `src/session/transcript.ts`
  - [x] 新增 `findLastCompaction()`
- [x] `src/session/SessionManager.ts`
  - [x] 新增 `SessionManagerOptions` 接口（`toolResultHeadChars` / `toolResultTailChars`）
  - [x] 构造函数接受 `SessionManagerOptions`，写盘前对 toolResult 执行硬上限裁剪（`capToolResults()`）
  - [x] 新增 `appendCompactionRecord()`
  - [x] 新增 `getLastCompactionSummary()`
  - [x] 新增 `getLastCompactionRecord()`
- [x] `src/agent-runner/AgentRunner.ts`
  - [x] 新增 `compactHistory()` 私有方法
  - [x] `loadHistory()` 改造：感知压缩记录，注入摘要
  - [x] `run()` 外层改为 retry 循环（`MAX_COMPACTION_RETRIES = 3`），捕获 `ContextOverflowError` → `compactHistory()` → retry `runAttempt`
  - [x] `callLLMStream()` 捕获 LLM API 溢出错误 → throw `ContextOverflowError`
  - [x] 压缩完成后更新 SessionEntry 元数据
- [x] `src/agent-runner/types.ts`
  - [x] `AgentEvent` 新增 `compaction_start` / `compaction_end`
- [x] `src/runtime/RuntimeApp.ts`
  - [x] `runTurnInternal()` 传入 `compaction` 配置和 `contextWindowTokens`
- [x] `src/runtime/bootstrap.ts`
  - [x] `createDefaultRuntimeDependencies()` 的 `createSessionManager` 接受并透传 `SessionManagerOptions`
  - [x] `bootstrapRuntime()` 从 `resolvedConfig.compaction` 传入 `toolResultHeadChars` / `toolResultTailChars`
- [x] `src/runtime/types.ts`
  - [x] `RuntimeDependencies.createSessionManager` 签名增加 `options?: SessionManagerOptions`

### Phase 3: 增强特性

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
| token > available，无可裁剪 tool result | route = "compact" |
| token > available，聚合裁剪可覆盖溢出 | route = "truncate_tool_results_only" |
| token > available，聚合裁剪不足以覆盖溢出 | route = "compact" |
| 临界值（恰好等于 available） | route = "fits" |
| reducibleChars 恰好等于 truncateOnlyThreshold | route = "truncate_tool_results_only" |

### 13.4 聚合裁剪（pruneToolResultsAggregate）

| 测试用例 | 预期行为 |
|---------|---------|
| 总 chars <= 聚合预算 | 返回原数组引用，不裁剪 |
| 总 chars 超预算，各 result 等大 | 等比裁剪，各 result 缩至相同大小 |
| 含极小 result（小于 minKeepChars） | 小 result 不裁剪，预算多余部分让给其他 result |
| 不修改原数组 | 原始 messages 不变 |

### 13.5 消息拆分

| 测试用例 | 预期行为 |
|---------|---------|
| keepRecentTurns=3，消息足够多 | 保留最近 3 个 user 轮次 + 其后的 assistant/toolResult |
| keepRecentTurns=3，消息不足 3 轮 | 不压缩（toCompress 为空） |
| tool_use + tool_result 在边界上 | 配对不被拆散，向前移动 splitIndex |
| 只有 user/assistant 消息（无 tool） | 正常拆分 |

### 13.6 LLM 摘要压缩（集成测试）

| 测试用例 | 预期行为 |
|---------|---------|
| 正常压缩 | 旧消息被摘要替换，近期消息保留，压缩记录写入 JSONL |
| LLM 摘要失败 | 降级到兜底文本，不阻塞对话 |
| 压缩后 token 仍超限 | 抛出 CompactionError |
| 多次压缩同一 session | compactionCount 递增，每次有独立的 CompactionRecord |
| 压缩后再加载历史 | loadHistory 注入最近摘要 + 保留区消息 |

### 13.7 Overflow 错误恢复

| 测试用例 | 预期行为 |
|---------|---------|
| LLM 返回 context_length_exceeded | 自动压缩 + 重试 |
| LLM 返回其他错误 | 正常抛出，不触发压缩 |
| 压缩后重试仍然失败 | 抛出 CompactionError（不无限重试） |

### 13.8 端到端测试（test-runtime-app.ts）

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
| `src/config/types.ts` | 新增 `CompactionConfig`；`AgentDefaults` 添加 `compaction`；`LLMConfig` 新增 `contextWindowTokens` |
| `src/config/defaults.ts` | 添加 `compaction` 默认值；`llm` 新增 `contextWindowTokens: 200_000` |
| `src/session/types.ts` | `CompactionRecord` 扩展字段 |
| `src/session/transcript.ts` | 新增 `findLastCompaction()` |
| `src/session/SessionManager.ts` | 新增 `SessionManagerOptions` 接口；构造函数接受选项，写盘前对 toolResult 做硬上限裁剪；新增 `appendCompactionRecord()`、`getLastCompactionSummary()`、`getLastCompactionRecord()` |
| `src/agent-runner/types.ts` | `RunParams`/`RunResult`/`AgentEvent` 扩展；`RunParams` 新增 `contextWindowTokens` |
| `src/agent-runner/AgentRunner.ts` | 集成三层压缩逻辑 |
| `src/runtime/RuntimeApp.ts` | 传入 `compaction` 配置 |
| `src/runtime/bootstrap.ts` | `createSessionManager` 透传 `SessionManagerOptions`；`bootstrapRuntime()` 从 compaction 配置传入写盘截断参数 |
| `src/runtime/types.ts` | `RuntimeDependencies.createSessionManager` 签名增加 `options?: SessionManagerOptions` |
