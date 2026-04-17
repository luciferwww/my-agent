# OpenClaw vs my-agent Compaction 差异分析

> 初版日期：2026-04-16  
> 最后更新：2026-04-17（Phase 1 + Phase 2 + Gap 2 完成）  
> 基于 OpenClaw 代码路径：`C:\dev\my-agent\openclaw`  
> 基于 my-agent 设计文档：`docs/architecture/compaction-design.md`

---

## 相同点（已对齐）

| 方面 | OpenClaw | my-agent |
|------|---------|---------|
| 分层设计 | 裁剪 → 预判 → LLM 摘要 | 同（Layer 1/2/3） |
| prompt 独立传入 | `estimatePrePromptTokens({messages, systemPrompt, prompt})` — prompt 作为独立字符串参数，单独计入估算，不合入 messages | `estimatePromptTokens({messages, systemPrompt, currentPrompt})` — 同，`currentPrompt` 显式传入，`reserveTokens` 仅覆盖模型输出 |
| Token 估算安全边际 | `SAFETY_MARGIN = 1.2` | 同 |
| tool_use / tool_result 配对保护 | ✅ | ✅ |
| 外层 retry 上限 | `MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3` | `MAX_COMPACTION_RETRIES = 3` |
| 内层 90% 阈值检查 + throw | `installToolResultContextGuard` | 内层循环显式检查 |
| per-result 动态裁剪上限 | `contextWindowTokens × 4 × 0.3`（上限 40,000 chars） | `contextWindowTokens × 2 × 0.5 = contextWindowTokens`（更宽松） |
| keepRecentTurns 保留最近 N 轮 | ✅ | ✅ |
| 压缩记录持久化到 JSONL | ✅ | ✅（Phase 2） |

> **注**：per-result 上限两者思路相同（动态随窗口缩放），但具体值不同：OpenClaw 上限约为窗口的 30%（且硬限 40,000 chars），my-agent 上限为窗口的 50%（更宽松，适配大模型场景）。

---

## 已解决（设计完成 / 实施中）

### ~~Gap 1~~：预判路由 — 已引入 truncate_tool_results_only（Phase 1）

**背景**：原来 my-agent 只有 `fits` / `compact` 两路，所有溢出都走 LLM 压缩，无法避免不必要的 LLM 调用。

**OpenClaw 四路设计**（`preemptive-compaction.ts`）：

```
fits
compact_only                 ← 无可裁剪 tool result
truncate_tool_results_only   ← reducibleChars >= max(overflow×1.5, overflow+2048) → 只裁剪
compact_then_truncate        ← 先 LLM 压缩，成功后再追加聚合裁剪
```

**my-agent 采纳方案（三路）**：

```
fits
truncate_tool_results_only   ← 同上阈值；Layer 1.5 聚合裁剪（无需 LLM）
compact                      ← compact_only + compact_then_truncate 合并为一路
                                Phase 1：路由占位，throw Error（ContextOverflowError 尚未实现）
                                Phase 2：throw ContextOverflowError → 外层 retry → LLM 压缩
```

**与 OpenClaw 的差异**：
- **未引入** `compact_only` / `compact_then_truncate` 的细分。两者在 my-agent 中统一为 `compact`，因为 Phase 2 的 LLM 摘要压缩目前尚未实现，细分无实际收益。
- `compact_then_truncate` 可在 Phase 3 补充（先压缩后再做聚合裁剪）。

**路由阈值**：
```typescript
// context-budget.ts（内部常量）
const CHARS_PER_TOKEN = 4;               // 通用文本估算：chars / 4 ≈ tokens
const TRUNCATION_BUFFER_TOKENS = 512;    // 路由阈值安全冗余（覆盖估算误差）

truncateOnlyThreshold = max(
  overflowTokens × 4 + 512 × 4,         // overflow + 2048 chars 缓冲
  ceil(overflowTokens × 4 × 1.5),        // 或 1.5 倍 overflow chars
)
```

**聚合预算**（与 OpenClaw `MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3` 对齐）：
```typescript
// tool-result-pruning.ts（export）
export const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.3;
// aggregateBudgetChars = contextWindowTokens × 4 × 0.3
```

**可节省量估算**（比 OpenClaw 简化，增加了 minKeepChars 约束）：
```
reducibleChars = min(
  max(0, totalToolResultChars - aggregateBudgetChars),   // 聚合预算约束
  sum(max(0, result.length - minKeepChars) for all)      // 最小保留量约束
)
```

**实施状态**：Phase 1（token 估算、tool result 裁剪、预判路由）和 Phase 2（LLM 摘要压缩、overflow retry 循环、compaction record 持久化）均已完成。集成测试：`scripts/test-agent-runner-compaction-integration.ts`（P0）、`scripts/test-agent-runner-compaction-reload-integration.ts`（P1）。

---

## 待解决差异

### ~~Gap 2~~：tool result 裁剪范围（内存 vs 持久化）— 已完成

| | OpenClaw | my-agent |
|--|--|--|
| 裁剪作用范围 | `truncateOversizedToolResultsInSession` — **修改 session 文件** | `SessionManager.capToolResults()` — **写盘前硬上限裁剪** |
| 下次 turn 是否生效 | ✅ 一次裁剪，永久生效 | ✅ 同，写盘时即裁剪，后续 loadHistory() 无需重复处理 |

**实现方案**（2026-04-17 完成）：

在 `appendMessage()` 写入 JSONL 之前，对 `role === 'toolResult'` 的消息执行硬上限裁剪：

```typescript
// src/session/SessionManager.ts

export interface SessionManagerOptions {
  toolResultHeadChars?: number;
  toolResultTailChars?: number;
}

// appendMessage() 写盘前：
const persistedMessage = message.role === 'toolResult'
  ? { ...message, content: this.capToolResults(message.content) }
  : message;
```

裁剪配置通过 `SessionManagerOptions` 注入，`bootstrapRuntime()` 从 `resolvedConfig.compaction` 中传入：

```typescript
// src/runtime/bootstrap.ts
const sessionManager = deps.createSessionManager(options.workspaceDir, {
  toolResultHeadChars: resolvedConfig.compaction.toolResultHeadChars,
  toolResultTailChars: resolvedConfig.compaction.toolResultTailChars,
});
```

**与 OpenClaw 的差异**：
- OpenClaw 在写盘后再次扫描文件做写回（`truncateOversizedToolResultsInSession`）
- my-agent 在 `appendMessage()` 写盘之前就截断，更简洁，磁盘上只存储截断后的数据

---

### Gap 3：摘要生成策略（多阶段 vs 单次）

| | OpenClaw | my-agent |
|--|--|--|
| 摘要方式 | `summarizeInStages()` — 自适应分块 → 各块摘要 → LLM 合并 | `compactMessages()` — 单次 LLM 摘要 |
| 超大对话处理 | 拆分为 N 个 part，分别摘要后合并 | 全量传给 LLM 一次生成 |
| 摘要失败降级 | 三级：完整 → 跳过超大消息的部分摘要 → 兜底文本 | 两级：LLM 摘要 → 兜底文本 |

**影响**：超长对话（> 100 轮，或单次消息极大）时，my-agent 的全量摘要可能超出摘要模型的输入上限，导致失败后直接降级为兜底文本，丢失大量信息。

**建议**：Phase 3 增强特性中补充多阶段摘要支持。

---

### Gap 4：timeout 触发压缩

**OpenClaw**（`run.ts`）：

```typescript
const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;
// LLM 超时 + prompt token 占比 > 65% → 主动压缩再 retry
if (timedOut && tokenUsedRatio > 0.65 && timeoutCompactionAttempts < MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
  await contextEngine.compact(...);
  continue;
}
```

**my-agent**：未设计此路径。超时直接返回错误给用户。

**影响**：大上下文场景下，LLM 超时往往因 prompt 过长（推理时间长），此时压缩后 retry 大概率能成功。my-agent 会直接报错。

**建议**：Phase 3 中作为可选增强项补充。

---

### Gap 5：Memory Flush（压缩前刷写）

**OpenClaw**：context 达 ~70% 窗口时，触发静默 turn，让 agent 将关键状态写入 MEMORY.md，再执行压缩。

**my-agent**：**明确不实现**。my-agent 的 memory 系统是语义向量索引（被动写入），非 agent 主动写入模式，不适用此机制。

**建议**：无需跟进。

---

## 优先级总览

| Gap | 严重性 | 状态 | 建议优先级 |
|-----|-------|------|----------|
| ~~Gap 1：缺少 truncate_tool_results_only 路由~~ | 中 | **Phase 1 + Phase 2 完成** | — |
| ~~Gap 2：tool result 裁剪只在内存~~ | 低（重复开销，初期可接受） | **已完成** | — |
| Gap 3：单次摘要 vs 多阶段摘要 | 中（超长对话时有风险） | 待处理 | Phase 3 |
| Gap 4：无 timeout 触发压缩 | 低中（用户体验差，但不阻断功能） | 待处理 | Phase 3 可选 |
| Gap 5：无 Memory Flush | N/A（设计决策，不适用） | 不跟进 | — |
