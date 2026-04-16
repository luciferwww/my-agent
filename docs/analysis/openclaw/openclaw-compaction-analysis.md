# OpenClaw 对话压缩（Compaction）机制深度分析

> 分析日期：2026-04-13  
> 代码路径：`C:\dev\my-agent\openclaw`

---

## 目录

- [1. 概述](#1-概述)
- [2. 五层压缩机制总览](#2-五层压缩机制总览)
- [3. 核心压缩引擎](#3-核心压缩引擎compactionts)
- [4. 会话压缩编排](#4-会话压缩编排compactts)
- [5. 预判式压缩](#5-预判式压缩preemptive-compactionts)
- [6. 上下文裁剪](#6-上下文裁剪context-pruning)
- [7. Memory Flush（压缩前刷写）](#7-memory-flush压缩前刷写)
- [8. 压缩指令构建](#8-压缩指令构建)
- [9. 配置参考](#9-配置参考)
- [10. Transcript 持久化格式](#10-transcript-持久化格式)
- [11. 关键文件索引](#11-关键文件索引)
- [12. 对 my-agent 的借鉴意义](#12-对-my-agent-的借鉴意义)

---

## 1. 概述

OpenClaw 实现了一套**多层级、渐进式**的对话压缩系统，用于管理长对话场景下的上下文窗口溢出问题。核心思路是：

1. **轻量裁剪优先**：先尝试裁剪冗长的工具返回结果（不需要调用 LLM）
2. **LLM 摘要兜底**：裁剪不够时，调用 LLM 对历史消息生成摘要
3. **分阶段处理**：超大对话分块摘要再合并，避免单次摘要超出模型能力
4. **安全保障**：tool_use/tool_result 配对保护、标识符保留、超时机制

整体数据流：

```
对话进行中
  │
  ├─ [每轮] Context Pruning（轻量裁剪 tool result）
  │     → 不改变持久化数据，仅影响发给 LLM 的 messages
  │
  ├─ [接近上限] Memory Flush（压缩前刷写关键状态到记忆）
  │     → 确保压缩丢失的信息已被保存
  │
  └─ [触发压缩] Compaction（LLM 生成摘要 + 裁剪历史）
        ├─ Preemptive（预判式，发送前检测）
        ├─ Overflow（被动式，LLM 返回错误后触发）
        └─ Manual（用户手动 /compact）
```

### 完整流程图：一轮对话中各压缩机制的触发时序

```
用户发送消息
│
▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Phase A: 构建 Prompt                                                    │
│                                                                          │
│  加载 session 历史 ──► 拼装 system prompt + messages + 用户消息           │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ L1: Context Pruning (pruner.ts)                     [每轮自动]  │     │
│  │                                                                 │     │
│  │  计算 ratio = totalChars / charWindow                           │     │
│  │       │                                                         │     │
│  │       ├─ ratio < softTrimRatio ──► 不裁剪，原样通过             │     │
│  │       │                                                         │     │
│  │       ├─ ratio >= softTrimRatio ──► Soft Trim                   │     │
│  │       │   对可裁剪的 toolResult 保留头尾，中间替换为 "..."       │     │
│  │       │       │                                                 │     │
│  │       │       ├─ ratio 降到 < hardClearRatio ──► 完成           │     │
│  │       │       │                                                 ��     │
│  │       │       └─ ratio 仍 >= hardClearRatio ──► Hard Clear      │     │
│  │       │           用 placeholder 替换整个 toolResult 内容        │     │
│  │       │                                                         │     │
│  │  ⚠ 仅影响内存中的 messages，不修改持久化数据                     │     │
│  │  ⚠ 保护区：首个 user 消息之前 + 最近 N 个 assistant 不裁剪      │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
│
▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Phase B: 发送前预检                                                      │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ L3: Preemptive Compaction (preemptive-compaction.ts)            │     │
│  │                                                                 │     │
│  │  estimatedTokens = (messages + system + user) × 1.2            │     │
│  │  overflowTokens  = estimatedTokens - (contextWindow - reserve) │     │
│  │       │                                                         │     │
│  │       ├─ overflow <= 0                                          │     │
│  │       │   route = "fits" ──────────────────────► 直接发送 LLM   │     │
│  │       │                                                         │     │
│  │       ├─ overflow > 0 且 无可裁剪 toolResult                    │     │
│  │       │   route = "compact_only" ──────────────► 跳到 Phase C   │     │
│  │       │                                                         │     │
│  │       ├─ overflow > 0 且 toolResult 可释放 >= 溢出 × 1.5       │     │
│  │       │   route = "truncate_tool_results_only" ► 裁剪后发送     │     │
│  │       │                                                         │     │
│  │       └─ overflow > 0 且 toolResult 可释放 < 溢出 × 1.5        │     │
│  │           route = "compact_then_truncate" ─────► 跳到 Phase C   │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
│                                          │
│ route = "fits" 或                         │ route = "compact_only" 或
│ "truncate_tool_results_only"              │ "compact_then_truncate"
▼                                          ▼
┌──────────────────────┐     ┌─────────────────────────────────────────────┐
│ Phase D: 调用 LLM     │     │ Phase C: 执行完整压缩                       │
│                        │     │                                             │
│  发送 messages 到 LLM  │     │  ┌───────────────────────────────────────┐  │
│       │                │     │  │ L2: Memory Flush (可选，在压缩前触发)  │  │
│       ├─ 成功          │     │  │                                       │  │
│       │   返回结果     │     │  │  context 达 ~70% 窗口？                │  │
│       │                │     │  │  是 → 静默 turn，写入 MEMORY.md       │  │
│       └─ 失败          │     │  │  否 → 跳过                            │  │
│           │            │     │  └───────────────────────────────────────┘  │
│           ▼            │     │       │                                     │
│    ┌──────────────┐    │     │       ▼                                     │
│    │ 是上下文溢出   │    │     │  ┌───────────────────────────────────────┐  │
│    │ 错误？        │    │     │  │ L4: Compaction (compact.ts)           │  │
│    │   │           │    │     │  │                                       │  │
│    │   ├─ 否       │    │     │  │  1. 加载完整 session 历史              │  │
│    │   │  抛出错误  │    │     │  │  2. 验证有真实对话内容                 │  │
│    │   │           │    │     │  │  3. splitMessagesByTokenShare()       │  │
│    │   └─ 是       │    │     │  │     按 token 比例拆分（保护 tool 配对）│  │
│    │      │        │    │     │  │  4. summarizeInStages()               │  │
│    │      ▼        │    │     │  │     各块分别摘要 → 合并               │  │
│    │  跳到 Phase C  │    │     │  │  5. 用摘要替换旧消息                   │  │
│    └──────────────┘    │     │  │  6. 写入 compaction 记录到 JSONL       │  │
│                        │     │  │  7. 更新 SessionEntry                  │  │
│                        │     │  │       compactionCount++                │  │
│                        │     │  └───────────────────────────────────────┘  │
│                        │     │       │                                     │
│                        │     │       ▼                                     │
│                        │     │  压缩后仍溢出？                             │
│                        │     │  ├─ 否 → 回到 Phase D（用压缩后的消息）     │
│                        │     │  └─ 是 → 级联重试（再次压缩，有次数上限）   │
│                        │     └─────────────────────────────────────────────┘
└──────────────────────┘
│
▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Phase E: 后处理                                                          │
│                                                                          │
│  保存 assistant 回复到 session                                            │
│  如有 tool_use → 执行工具 → 保存 toolResult → 回到 Phase A（下一轮内循环）│
│  无 tool_use → 返回结果给用户                                             │
└──────────────────────────────────────────────────────────────────────────┘


用户手动 /compact 命令：
  └─ 直接跳到 Phase C（trigger = "manual"），不经过 Phase A/B
```

### 摘要生成内部流程（summarizeInStages 详细展开）

```
summarizeInStages()
│
├─ 消息 < minMessagesForSplit 或 totalTokens <= maxChunkTokens
│   └─► summarizeWithFallback() ──► 单次摘要
│
└─ 消息量足够大
    │
    ├─ splitMessagesByTokenShare(messages, parts)
    │   拆分为 N 个块（保持 tool_use/tool_result 在同一块）
    │
    ├─ 每个块 → summarizeWithFallback()
    │   │
    │   ├─ Level 1: 完整摘要（所有消息交给 LLM）
    │   │   └─ 失败 ↓
    │   ├─ Level 2: 部分摘要（跳过超大消息，标注 [Large ... omitted]）
    │   │   └─ 失败 ↓
    │   └─ Level 3: 兜底文本 "Context contained N messages..."
    │
    └─ 所有部分摘要 → LLM 合并
        使用 MERGE_SUMMARIES_INSTRUCTIONS 指引合并
        保留：活跃任务状态、批量进度、最后请求、决策理由、TODO
```

---

## 2. 五层压缩机制总览

| 层级 | 机制 | 触发条件 | 是否调 LLM | 是否持久化 | 核心文件 |
|------|------|---------|-----------|-----------|---------|
| **L1** | Context Pruning | 每轮自动，context 占比超阈值 | ❌ | ❌ 仅内存 | `src/agents/pi-hooks/context-pruning/pruner.ts` |
| **L2** | Memory Flush | context 达 ~70% 窗口 | ✅ 静默调用 | ✅ 写入记忆文件 | `src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts` |
| **L3** | Preemptive Compaction | 发送前估算超限 | ✅ | ✅ | `src/agents/pi-embedded-runner/run/preemptive-compaction.ts` |
| **L4** | Overflow Compaction | LLM 返回上下文溢出错误 | ✅ | ✅ | `src/agents/pi-embedded-runner/compact.ts` |
| **L5** | Manual Compaction | 用户发送 `/compact` | ✅ | ✅ | `src/agents/auto-reply/commands-compact.ts` |

---

## 3. 核心压缩引擎（compaction.ts）

**文件**：`src/agents/compaction.ts`（577 行）

这是整个压缩系统的算法核心，提供消息拆分、token 估算、摘要生成等底层能力。

### 3.1 关键常量

```typescript
// src/agents/compaction.ts:17-21
export const BASE_CHUNK_RATIO = 0.4;       // 每个分块占总 token 的 40%
export const MIN_CHUNK_RATIO = 0.15;       // 最小分块比例 15%
export const SAFETY_MARGIN = 1.2;          // token 估算的 20% 安全缓冲
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;                   // 默认分 2 块
```

```typescript
// src/agents/compaction.ts:212
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;  // 摘要 prompt 本身的开销预留
```

### 3.2 消息拆分：splitMessagesByTokenShare()

**位置**：`src/agents/compaction.ts:118-207`

按 token 比例将消息数组拆分为多个块，**核心特性是保护 tool_use/tool_result 配对不被拆散**。

算法流程：

```
1. 计算总 token 数，按 parts 均分得到每块目标 token 数
2. 遍历消息，累计当前块的 token
3. 当累计超过目标且无 pending 的 tool call 时 → 切块
4. 遇到 assistant 消息中的 tool_use → 记录 pendingToolCallIds
5. 遇到 toolResult → 从 pending 中移除对应 ID
6. pending 不为空时绝不切块（保证 tool_use 和 tool_result 在同一块）
7. pending 清空后如果已超目标 → 在 pending 开始处切块
```

关键代码片段：

```typescript
// src/agents/compaction.ts:136-152
let pendingToolCallIds = new Set<string>();
let pendingChunkStartIndex: number | null = null;

// 在 pending boundary 处安全拆分
const splitCurrentAtPendingBoundary = (): boolean => {
  if (pendingChunkStartIndex === null || pendingChunkStartIndex <= 0 || ...) {
    return false;
  }
  chunks.push(current.slice(0, pendingChunkStartIndex));
  current = current.slice(pendingChunkStartIndex);
  // ...
};
```

### 3.3 硬限制分块：chunkMessagesByMaxTokens()

**位置**：`src/agents/compaction.ts:214-254`

当消息总量超过单次 LLM 调用能处理的上限时，按最大 token 数分块。与 `splitMessagesByTokenShare` 的区别是这里按**绝对上限**切分，而非按比例。

```typescript
// src/agents/compaction.ts:224
const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
```

### 3.4 自适应分块比例：computeAdaptiveChunkRatio()

**位置**：`src/agents/compaction.ts:260-279`

根据平均消息大小动态调整分块比例。当单条消息平均占上下文 >10% 时，减小分块比例以避免分块过大。

```typescript
// src/agents/compaction.ts:273-276
if (avgRatio > 0.1) {
  const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
  return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
}
```

### 3.5 渐进式降级摘要：summarizeWithFallback()

**位置**：`src/agents/compaction.ts:378-440`

三级降级策略：

```
Level 1: 完整摘要（所有消息 → LLM 生成摘要）
    ↓ 失败
Level 2: 部分摘要（跳过超大消息，仅摘要小消息 + 标注超大消息）
    ↓ 失败
Level 3: 最终兜底（纯文本标注消息数量和超大消息数）
```

超大消息判定标准（`isOversizedForSummary`，第 285-288 行）：

```typescript
// 单条消息 > 上下文窗口的 50% → 视为超大
const tokens = estimateCompactionMessageTokens(msg) * SAFETY_MARGIN;
return tokens > contextWindow * 0.5;
```

### 3.6 多阶段摘要：summarizeInStages()

**位置**：`src/agents/compaction.ts:442-506`

处理大型对话的入口函数。当消息量足够大时，先拆分为多个 part，分别摘要，再合并。

```
消息数组
  ├─ 消息太少或 token 不多 → 直接 summarizeWithFallback()
  └─ 消息足够多 →
       ├─ splitMessagesByTokenShare() 拆分为 N 个 part
       ├─ 每个 part 单独 summarizeWithFallback()
       └─ 所有部分摘要 → 合并摘要（用 MERGE_SUMMARIES_INSTRUCTIONS 指引 LLM 合并）
```

合并指令要求 LLM 保留的信息（第 22-35 行）：

- 活跃任务及其当前状态（进行中、阻塞、待定）
- 批量操作进度（如 "5/17 items completed"）
- 用户最后一个请求及处理进展
- 已做出的决策及理由
- TODO、开放问题、约束条件
- 承诺和后续跟进事项

### 3.7 历史裁剪：pruneHistoryForContextShare()

**位置**：`src/agents/compaction.ts:508-570`

当历史消息占用的 token 超过上下文预算的一定比例（默认 50%）时，从最早的消息开始丢弃，为新消息和 system prompt 留出空间。

```typescript
// src/agents/compaction.ts:522-523
const maxHistoryShare = params.maxHistoryShare ?? 0.5;
const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
```

丢弃后会调用 `repairToolUseResultPairing()` 修复因丢弃导致的孤立 tool_result。

### 3.8 安全措施

**标识符保留**（第 36-38 行）：

```typescript
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, tokens, API keys, hostnames, IPs, ports, URLs, and file names.";
```

**安全过滤**（第 102-104 行）：

```typescript
// toolResult.details 可能包含不可信/冗长的负载，压缩前剥离
const safe = stripToolResultDetails(messages);
```

---

## 4. 会话压缩编排（compact.ts）

**文件**：`src/agents/pi-embedded-runner/compact.ts`（1,401 行）

这是压缩的运行时编排层，负责从 session 加载消息、调用压缩引擎、持久化结果。

### 4.1 主入口：compactEmbeddedPiSession()

**位置**：`src/agents/pi-embedded-runner/compact.ts:1169-1386`

带有 lane（队列）机制，确保同一 session 的压缩不会并发执行。

### 4.2 核心编排：compactEmbeddedPiSessionDirect()

**位置**：`src/agents/pi-embedded-runner/compact.ts:298-1162`

7 个阶段：

```
Phase 1: Setup & Model Resolution       (298-400)
  └─ 解析模型配置、API key、超时设置

Phase 2: Session Infrastructure          (401-488)
  └─ 加载 SessionManager、验证有可压缩内容

Phase 3: Tool & Session Setup            (490-749)
  └─ 初始化工具执行器、准备 session 上下文

Phase 4: Session Loading                 (716-895)
  └─ 从 JSONL 读取完整消息历史

Phase 5: Compaction Execution            (896-1103)
  └─ 调用 summarizeInStages() 生成摘要
  └─ 调用 pruneHistoryForContextShare() 裁剪历史
  └─ 写入压缩记录到 JSONL

Phase 6: Post-Compaction Actions         (1068-1103)
  └─ 更新 SessionEntry（compactionCount++）
  └─ 触发事件通知

Phase 7: Error Handling & Retry          (1104-1136)
  └─ 压缩后仍溢出 → 级联重试
```

### 4.3 触发来源

| 触发方式 | 来源 | trigger 值 |
|---------|------|-----------|
| LLM 溢出错误 | overflow-compaction.ts | `"overflow"` |
| 预判式检测 | preemptive-compaction.ts | `"budget"` |
| 用户手动 | commands-compact.ts | `"manual"` |
| 级联重试 | compaction-retry-aggregate-timeout.ts | `"overflow"` |

---

## 5. 预判式压缩（preemptive-compaction.ts）

**文件**：`src/agents/pi-embedded-runner/run/preemptive-compaction.ts`（91 行）

在发送请求给 LLM **之前**，估算 prompt 总 token 数，判断是否会溢出。这避免了浪费一次 API 调用才发现溢出的情况。

### 5.1 路由策略

```typescript
// src/agents/pi-embedded-runner/run/preemptive-compaction.ts:12-16
export type PreemptiveCompactionRoute =
  | "fits"                        // 不需要任何处理
  | "compact_only"                // 需要完整压缩
  | "truncate_tool_results_only"  // 仅裁剪 tool result 即可
  | "compact_then_truncate";      // 先压缩再裁剪
```

### 5.2 路由决策逻辑

**位置**：`src/agents/pi-embedded-runner/run/preemptive-compaction.ts:40-90`

```
estimatedPromptTokens = (历史消息 + system prompt + 用户消息) × SAFETY_MARGIN
overflowTokens = estimatedPromptTokens - (contextWindow - reserveTokens)

if overflowTokens <= 0 → "fits"
elif 没有可裁剪的 tool result → "compact_only"
elif tool result 可释放空间 >= 溢出量 × 1.5 → "truncate_tool_results_only"
else → "compact_then_truncate"
```

关键判断（第 66-81 行）：

```typescript
// 裁剪仅 tool result 是否足够？需要溢出量 + 缓冲 或 溢出量的 1.5 倍
const truncateOnlyThresholdChars = Math.max(
  overflowChars + truncationBufferChars,
  Math.ceil(overflowChars * 1.5),
);

if (toolResultReducibleChars <= 0) {
  route = "compact_only";
} else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
  route = "truncate_tool_results_only";
} else {
  route = "compact_then_truncate";
}
```

---

## 6. 上下文裁剪（Context Pruning）

OpenClaw 有两个独立的裁剪机制，职责不同：

| 机制 | 文件 | 层级 | 触发时机 |
|------|------|------|---------|
| **Tool Result Context Guard** | `tool-result-context-guard.ts` | 内嵌 Runner | 每次 LLM 调用前（含内层 tool 循环） |
| **Context Pruning（Hooks）** | `pruner.ts` | Hooks 层 | 每轮自动，基于 ratio 阈值 |

### 6.0 Tool Result Context Guard（内层循环保护）

**文件**：`src/agents/pi-embedded-runner/tool-result-context-guard.ts`

这是内嵌 runner 在每次 LLM 调用前执行的轻量保护，通过劫持 `agent.transformContext` 实现，同时做两件事：

**第一步：截断单条过大的 tool result**

```typescript
// tool-result-context-guard.ts:14-15
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;          // 单条最大占 50%
// tool-result-char-estimator.ts:4
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2; // tool result 每 token 约 2 字符

maxSingleToolResultChars = contextWindowTokens × 2 × 0.5 = contextWindowTokens
// 200k 窗口 → 单条最大 200,000 字符；32k 窗口 → 32,000 字符
```

截断方式：头部保留，超出部分加 `[... N more characters truncated]` 标记。

**第二步：检查总量是否超 90% 阈值**

```typescript
// tool-result-context-guard.ts:15
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

maxContextChars = contextWindowTokens × CHARS_PER_TOKEN_ESTIMATE × 0.9
               = contextWindowTokens × 4 × 0.9

if (totalChars > maxContextChars) {
  throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
}
```

这个 `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE` 抛出后，被外层 retry 循环（`run.ts`）捕获，触发压缩并重试整个 attempt。

**两步保护的意义**

- 第一步将单条 result 上限设为 50% 窗口，保证单条不能撑满上下文
- 第二步检查 90% 时，溢出一定是**历史积累**导致的（不是当前 result 过大）
- 因此压缩历史后 retry 必然有效，不会陷入循环

**与 `pruner.ts` 的区别**

| | Tool Result Context Guard | Context Pruning (pruner.ts) |
|--|--|--|
| 触发层 | 内嵌 Runner（`transformContext`） | Hooks 层 |
| 截断上限 | 动态：50% × contextWindow | 静态配置值 |
| 超限行为 | throw → 外层 retry → 压缩 | 继续当前 turn（无 retry） |
| 90% 检查 | ✅ | ❌ |

### 6.1 Context Pruning（Hooks 层）两级裁剪

**文件**：`src/agents/pi-hooks/context-pruning/pruner.ts`（382 行）

最轻量的压缩层，**不调用 LLM，不修改持久化数据**，仅在发送给 LLM 前对 messages 做内存级裁剪。

| 级别 | 触发条件 | 操作 |
|------|---------|------|
| **Soft Trim** | context 占比 > `softTrimRatio` | 保留 head + tail，中间用 `...` 替代 |
| **Hard Clear** | soft trim 后占比仍 > `hardClearRatio` | 用 placeholder 替换整个 tool result |

### 6.2 Soft Trim 实现

**位置**：`src/agents/pi-hooks/context-pruning/pruner.ts:220-257`

```typescript
function softTrimToolResultMessage(params) {
  // 如果内容长度 <= maxChars → 不裁剪
  if (rawLen <= settings.softTrim.maxChars) { return null; }

  // 保留头部 headChars + 尾部 tailChars，中间用 ... 替代
  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}\n...\n${tail}`;
  // 附加裁剪说明
  const note = `[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;
  return { ...msg, content: [asText(trimmed + note)] };
}
```

### 6.3 主裁剪流程：pruneContextMessages()

**位置**：`src/agents/pi-hooks/context-pruning/pruner.ts:259-381`

```
1. 计算 charWindow = contextWindowTokens × CHARS_PER_TOKEN_ESTIMATE
2. 找到"保护尾部"的切割点（最近 N 个 assistant 消息不裁剪）
3. 找到第一个 user 消息的位置（之前的 identity 读取消息不裁剪）
4. 在可裁剪范围内：
   a. 遍历 toolResult 消息，判断工具是否允许裁剪（isToolPrunable）
   b. ratio > softTrimRatio → 对每个可裁剪的 toolResult 执行 soft trim
   c. ratio 仍 > hardClearRatio → 对剩余的 toolResult 执行 hard clear
5. 返回裁剪后的 messages 数组（不修改原数组）
```

安全保护：
- 第一个 user 消息之前的消息（通常是 SOUL.md 等初始化内容）永远不被裁剪
- 最近 N 个 assistant 消息不被裁剪
- 图片内容被替换为 `[image removed during context pruning]`

---

## 7. Memory Flush（压缩前刷写）

**文件**：`src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts`（59 行）

在执行真正的对话压缩**之前**，先触发一次静默的 agent turn，让 agent 将当前上下文中的关键信息写入长期记忆文件（MEMORY.md）。

### 7.1 为什么需要 Memory Flush？

压缩会丢弃大量历史消息（替换为摘要），如果这些消息中包含重要但尚未保存到 Memory 的信息，压缩后就永久丢失了。Memory Flush 就是压缩前的"最后一次保存机会"。

### 7.2 工作方式

1. 上下文达到 ~70% 窗口时触发
2. 注入一个静默的 user 消息（带 `NO_REPLY` token）
3. Agent 执行一个 turn，将关键状态写入记忆文件
4. 不产生用户可见的回复
5. 通过 SHA-256 去重，避免同一压缩周期内重复 flush

### 7.3 配置

```typescript
memoryFlush: {
  enabled: boolean,                  // 默认 true
  softThresholdTokens: number,       // 默认 4000
  prompt: string,                    // flush 时注入的 prompt
  systemPrompt: string,              // flush 时的 system prompt
}
```

### 7.4 跟踪字段

在 SessionEntry 中记录（`sessions.json`）：

- `memoryFlushAt`：最后一次 flush 的时间戳
- `memoryFlushCompactionCount`：flush 时的 compactionCount，用于去重

---

## 8. 压缩指令构建

**文件**：`src/agents/pi-hooks/compaction-instructions.ts`（69 行）

### 8.1 默认指令

```typescript
// src/agents/pi-hooks/compaction-instructions.ts:13-17
export const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";
```

### 8.2 指令优先级

```typescript
// src/agents/pi-hooks/compaction-instructions.ts:48-57
export function resolveCompactionInstructions(
  eventInstructions,    // SDK 层传入（最高优先级）
  runtimeInstructions,  // 配置文件指定
): string {
  return normalize(eventInstructions)
    ?? normalize(runtimeInstructions)
    ?? DEFAULT_COMPACTION_INSTRUCTIONS;
}
```

优先级：`SDK event 指令 > 配置文件指令 > 默认指令`

### 8.3 长度限制

```typescript
// src/agents/pi-hooks/compaction-instructions.ts:23
const MAX_INSTRUCTION_LENGTH = 800;  // ~200 tokens，防止 prompt 膨胀
```

### 8.4 标识符保留策略

**位置**：`src/agents/compaction.ts:69-81`

三种策略：

| 策略 | 行为 |
|------|------|
| `"strict"`（默认） | 保留所有标识符（UUID、hash、URL、文件名等） |
| `"off"` | 不注入保留指令 |
| `"custom"` | 使用用户自定义的保留指令 |

---

## 9. 配置参考

**定义文件**：`src/config/types.agent-defaults.ts`

完整配置结构（`agents.defaults.compaction`）：

```typescript
{
  // 基础配置
  mode: "default" | "safeguard",     // "default"=Pi SDK 模式，"safeguard"=OpenClaw 增强模式
  reserveTokens: number,             // 压缩后预留 token 数（默认 16384）
  reserveTokensFloor: number,        // 预留下限（默认 20000）
  
  // 摘要控制
  customInstructions: string,        // 自定义摘要指令
  identifierPolicy: "strict" | "off" | "custom",  // 标识符保留策略
  model: string,                     // 专用摘要模型（可选）
  
  // 超时与重试
  timeoutSeconds: number,            // 超时时间（默认 900s = 15 分钟）
  
  // 后处理
  truncateAfterCompaction: boolean,  // 压缩后是否再次裁剪
  notifyUser: boolean,               // 压缩后是否通知用户
  postCompactionSections: string[],  // 压缩后注入的额外段落
  
  // Memory Flush 子配置
  memoryFlush: {
    enabled: boolean,                // 默认 true
    softThresholdTokens: number,     // 默认 4000
    prompt: string,
    systemPrompt: string,
  },
}
```

---

## 10. Transcript 持久化格式

压缩记录以 `compaction` 类型写入 JSONL：

```jsonl
{"type":"compaction","id":"cmp-abc123","timestamp":"2026-04-13T10:00:00Z","reason":"overflow","firstKeptEntryId":"msg-042","tokensBefore":128000,"tokensAfter":32000,"summary":"The user asked about...","metrics":{"compactionCount":2,"droppedMessages":45,"droppedTokens":96000}}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `type` | 固定为 `"compaction"` |
| `id` | 压缩记录唯一 ID |
| `timestamp` | 压缩执行时间 |
| `reason` | 触发原因：`"overflow"` / `"manual"` / `"budget"` |
| `firstKeptEntryId` | 压缩后保留的第一条消息 ID |
| `tokensBefore` / `tokensAfter` | 压缩前后的 token 数 |
| `summary` | LLM 生成的摘要文本 |
| `metrics` | 压缩统计指标 |

Session Store 更新：

```typescript
// 在 sessions.json 的 SessionEntry 中
{
  compactionCount: number,   // 累计压缩次数，每次 +1
  totalTokens: number,       // 更新为压缩后的 token 数
  totalTokensFresh: true,    // 标记 token 数已刷新
}
```

---

## 11. 关键文件索引

### 核心算法

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/agents/compaction.ts` | 577 | 拆分、分块、摘要、降级、裁剪算法 |
| `src/agents/session-transcript-repair.ts` | — | tool_use/tool_result 配对修复 |
| `src/agents/tool-call-id.ts` | — | 提取 tool call / result ID |
| `src/agents/compaction-real-conversation.ts` | 86 | 检测是否有真实对话内容（非合成消息） |

### 运行时编排

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/agents/pi-embedded-runner/compact.ts` | 1,401 | 会话压缩主编排（7 阶段） |
| `src/agents/pi-embedded-runner/run/preemptive-compaction.ts` | 91 | 预判式路由决策 |
| `src/agents/pi-embedded-runner/compaction-hooks.ts` | ~250 | 压缩生命周期钩子 |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | — | tool result 裁剪潜力估算 |
| `src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts` | 59 | Memory Flush 协调 |

### 上下文裁剪

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | 241 | 内层循环 tool result 截断 + 90% 溢出检测（`SINGLE_TOOL_RESULT_CONTEXT_SHARE=0.5`） |
| `src/agents/pi-embedded-runner/tool-result-char-estimator.ts` | 166 | tool result 字符估算（`TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE=2`） |
| `src/agents/pi-hooks/context-pruning/pruner.ts` | 382 | Soft trim + Hard clear 实现（Hooks 层） |
| `src/agents/pi-hooks/context-pruning/settings.ts` | — | 裁剪配置解析 |
| `src/agents/pi-hooks/context-pruning/tools.ts` | — | 可裁剪工具判定 |

### 指令与配置

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/agents/pi-hooks/compaction-instructions.ts` | 69 | 摘要指令构建与优先级 |
| `src/config/types.agent-defaults.ts` | ~417 | 配置类型定义 |

### 错误处理与重试

| 文件 | 说明 |
|------|------|
| `src/agents/pi-embedded-runner/compaction-retry-aggregate-timeout.ts` | 级联重试（压缩后仍溢出） |
| `src/agents/pi-embedded-runner/compaction-timeout.ts` | 超时处理 |
| `src/agents/pi-hooks/compaction-safeguard.ts` | 安全检查 |

### 用户侧

| 文件 | 说明 |
|------|------|
| `src/agents/auto-reply/commands-compact.ts` | `/compact` 命令处理 |
| `docs/concepts/compaction.md` | 用户文档 |
| `docs/reference/session-management-compaction.md` | 深度参考文档 |

---

## 12. 对 my-agent 的借鉴意义

当前 `my-agent` 的 `AgentRunner`（`src/agent-runner/AgentRunner.ts`）将**全量历史**发送给 LLM，随着对话增长，必然会触达上下文窗口上限。

### 建议的渐进式引入路径

**阶段 1：基础 token 估算 + 预判检测**
- 实现 `estimateTokens()` 对消息做 token 估算
- 在 `run()` 方法中，发送 LLM 前检查总 token 是否接近上限
- 超限时先抛出明确错误，而非等 LLM 返回错误

**阶段 2：轻量级 Context Pruning**
- 仅裁剪 tool result 的冗长内容（保留头尾，中间省略）
- 不需要调 LLM，不影响持久化，代价最低
- 参考 `pruner.ts` 的 soft trim 逻辑

**阶段 3：LLM 摘要压缩**
- 实现基础的 `summarizeInStages()`
- 将旧消息生成摘要，替换历史中的早期消息
- 注意保持 tool_use/tool_result 配对完整性
- 压缩记录写入 session 持久化

**阶段 4：Memory Flush + 高级特性**
- 压缩前先将关键状态保存到记忆
- 自适应分块、多级降级、级联重试等
