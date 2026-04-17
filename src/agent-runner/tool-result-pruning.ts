/**
 * Tool result 裁剪（Layer 1）。
 *
 * 对超过动态阈值的 tool result 内容，保留头部和尾部，中间用省略标记替代。
 * 阈值由 contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare 计算。
 * 纯字符串操作，不调用 LLM，不修改持久化数据，仅影响发给 LLM 的 messages。
 */

import type { ChatMessage, ChatContentBlock } from '../llm-client/types.js';
import type { CompactionConfig } from '../config/types.js';

// ── 常量 ────────────────────────────────────────────────────

/**
 * Tool result 每 token 对应字符数估算。
 * 比普通文本（4 chars/token）更保守，因为 tool result 通常含更密集的结构化数据。
 */
export const TOOL_RESULT_CHARS_PER_TOKEN = 2;

/**
 * 聚合裁剪（Layer 1.5）中 tool result 总量的最大预算份额。
 * 聚合预算 = contextWindowTokens × 4 × AGGREGATE_TOOL_RESULT_CONTEXT_SHARE。
 * 由 context-budget.ts 导入用于路由阈值估算。
 */
export const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.3;

// ── 类型 ────────────────────────────────────────────────────

/** 裁剪回调信息 */
export interface PruneInfo {
  /** 消息在数组中的索引 */
  index: number;
  /** tool_use_id（如果有） */
  toolUseId?: string;
  /** 裁剪前字符数 */
  originalChars: number;
  /** 裁剪后字符数 */
  prunedChars: number;
}

// ── 内部工具 ────────────────────────────────────────────────

/**
 * 裁剪单个 tool_result block 的 content。
 * 保留头部 headChars + 尾部 tailChars，中间用省略标记替代。
 * 如果 content 未超限，返回 null 表示不需要裁剪。
 */
function pruneToolResultContent(
  content: string,
  maxChars: number,
  headChars: number,
  tailChars: number,
): string | null {
  if (content.length <= maxChars) {
    return null; // 不需要裁剪
  }

  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const trimmed = `${head}\n\n...\n\n${tail}`
    + `\n\n[Tool result trimmed: kept first ${headChars} and last ${tailChars}`
    + ` of ${content.length} chars]`;
  return trimmed;
}

// ── 公共 API ────────────────────────────────────────────────

/**
 * 裁剪 messages 中超大的 tool result 内容。
 *
 * 返回新的 messages 数组（immutable，不修改原数组）。
 * 仅裁剪 role='user' 且 content 中包含 type='tool_result' 的 block。
 *
 * 单条 tool result 的最大字符数由公式动态计算：
 *   maxChars = contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare
 *
 * @param messages - 消息数组
 * @param config - 裁剪相关配置（toolResultContextShare / toolResultHeadChars / toolResultTailChars）
 * @param contextWindowTokens - 模型上下文窗口大小（tokens），用于动态计算裁剪阈值
 * @param onPruned - 可选回调，每次裁剪时触发
 * @returns 裁剪后的新 messages 数组
 */
export function pruneToolResults(
  messages: ChatMessage[],
  config: Pick<CompactionConfig, 'toolResultContextShare' | 'toolResultHeadChars' | 'toolResultTailChars'>,
  contextWindowTokens: number,
  onPruned?: (info: PruneInfo) => void,
): ChatMessage[] {
  const maxChars = Math.floor(
    contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN * config.toolResultContextShare,
  );

  let modified = false;
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 只处理 role='user' 且 content 为数组的消息（tool_result 在 Anthropic API 中是 role='user'）
    if (msg.role !== 'user' || typeof msg.content === 'string') {
      result.push(msg);
      continue;
    }

    let msgModified = false;
    const newBlocks: ChatContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type !== 'tool_result') {
        newBlocks.push(block);
        continue;
      }

      const pruned = pruneToolResultContent(
        block.content,
        maxChars,
        config.toolResultHeadChars,
        config.toolResultTailChars,
      );

      if (pruned === null) {
        // 未超限，原样保留
        newBlocks.push(block);
      } else {
        // 裁剪了，创建新 block
        newBlocks.push({ ...block, content: pruned });
        msgModified = true;
        modified = true;
        onPruned?.({
          index: i,
          toolUseId: block.tool_use_id,
          originalChars: block.content.length,
          prunedChars: pruned.length,
        });
      }
    }

    result.push(msgModified ? { ...msg, content: newBlocks } : msg);
  }

  // 如果没有任何修改，返回原数组引用（避免不必要的对象创建）
  return modified ? result : messages;
}

// ── 聚合裁剪（Layer 1.5） ────────────────────────────────

/**
 * 聚合裁剪：将所有 tool result 按比例压缩到聚合预算内（Layer 1.5）。
 *
 * 适用于 truncate_tool_results_only 路由：溢出量可通过裁剪覆盖，无需 LLM 摘要。
 * 聚合预算 = contextWindowTokens × 4 × AGGREGATE_TOOL_RESULT_CONTEXT_SHARE。
 * 每条 result 的目标 chars = budget × (original / total)，按比例分配。
 * 低于 minKeepChars（toolResultHeadChars + toolResultTailChars）的 result 不裁剪。
 *
 * @param messages - Layer 1 处理后的消息数组
 * @param contextWindowTokens - 模型上下文窗口大小（tokens）
 * @param config - headChars / tailChars 配置（用于 minKeepChars 和裁剪格式）
 * @returns 裁剪后的新 messages 数组（immutable）
 */
export function pruneToolResultsAggregate(
  messages: ChatMessage[],
  contextWindowTokens: number,
  config: Pick<CompactionConfig, 'toolResultHeadChars' | 'toolResultTailChars'>,
): ChatMessage[] {
  const CHARS_PER_TOKEN = 4;
  const aggregateBudgetChars = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE,
  );
  const minKeepChars = config.toolResultHeadChars + config.toolResultTailChars;

  // 统计所有 tool result 总 chars
  let totalChars = 0;
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') totalChars += block.content.length;
    }
  }

  // 总量已在预算内，无需处理
  if (totalChars <= aggregateBudgetChars) return messages;

  // 按比例分配目标 chars，逐条裁剪
  let modified = false;
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== 'user' || typeof msg.content === 'string') {
      result.push(msg);
      continue;
    }

    let msgModified = false;
    const newBlocks: ChatContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type !== 'tool_result') {
        newBlocks.push(block);
        continue;
      }

      // 按比例分配预算，计算当前 result 的目标 chars
      const targetChars = Math.floor(aggregateBudgetChars * (block.content.length / totalChars));

      // 低于 minKeepChars 或已在目标内 → 不裁剪
      if (block.content.length <= targetChars || targetChars < minKeepChars) {
        newBlocks.push(block);
        continue;
      }

      const pruned = pruneToolResultContent(
        block.content,
        targetChars,
        config.toolResultHeadChars,
        config.toolResultTailChars,
      );

      if (pruned !== null) {
        newBlocks.push({ ...block, content: pruned });
        msgModified = true;
        modified = true;
      } else {
        newBlocks.push(block);
      }
    }

    result.push(msgModified ? { ...msg, content: newBlocks } : msg);
  }

  return modified ? result : messages;
}
