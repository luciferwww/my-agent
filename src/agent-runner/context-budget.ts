/**
 * 上下文预算检查（Layer 2）。
 *
 * 在发送 LLM 前估算总 token 数，决定路由策略：
 * - fits:                      不需要任何处理，直接发送
 * - truncate_tool_results_only: 溢出量可通过聚合裁剪（Layer 1.5）覆盖，无需 LLM
 * - compact:                   需要触发 LLM 摘要压缩（Layer 3）
 */

import type { ChatMessage } from '../llm-client/types.js';
import type { CompactionConfig } from '../config/types.js';
import { estimatePromptTokens } from './token-estimation.js';
import { AGGREGATE_TOOL_RESULT_CONTEXT_SHARE } from './tool-result-pruning.js';

// ── 局部常量 ────────────────────────────────────────────────

/** 通用文本每 token 对应字符数估算（用于路由阈值换算，非 tool result 专用）。 */
const CHARS_PER_TOKEN = 4;

/** 路由判断的安全冗余（tokens）。 */
const TRUNCATION_BUFFER_TOKENS = 512;

// ── 类型 ────────────────────────────────────────────────────

/** 预算检查路由策略 */
export type ContextBudgetRoute =
  | 'fits'                       // 不需要任何处理
  | 'truncate_tool_results_only' // 聚合裁剪（Layer 1.5）可覆盖溢出，无需 LLM
  | 'compact';                   // 需要 LLM 摘要压缩（Layer 3）

/** 预算检查结果 */
export interface ContextBudgetResult {
  /** 路由策略 */
  route: ContextBudgetRoute;
  /** 估算的 prompt token 数（已含安全边际） */
  estimatedTokens: number;
  /** 可用 token 预算（contextWindow - reserve） */
  availableTokens: number;
  /** 溢出 token 数（0 表示未溢出） */
  overflowTokens: number;
  /** 聚合裁剪可释放的最大字符数 */
  reducibleChars: number;
}

// ── 内部函数 ─────────────────────────────────────────────────

/**
 * 估算通过聚合裁剪（Layer 1.5）最多可释放的字符数。
 *
 * 公式：
 *   aggregateBudgetChars = contextWindowTokens × CHARS_PER_TOKEN × AGGREGATE_TOOL_RESULT_CONTEXT_SHARE
 *   totalToolResultChars = sum(block.content.length) for all tool_result blocks
 *   minKeepChars         = toolResultHeadChars + toolResultTailChars（每条 result 的不可压缩下限）
 *
 *   reducibleChars = min(
 *     max(0, totalToolResultChars - aggregateBudgetChars),  // 聚合预算约束
 *     sum(max(0, result.length - minKeepChars))             // 最小保留量约束
 *   )
 */
function estimateToolResultReductionPotential(
  messages: ChatMessage[],
  contextWindowTokens: number,
  config: Pick<CompactionConfig, 'toolResultHeadChars' | 'toolResultTailChars'>,
): number {
  const aggregateBudgetChars = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE,
  );
  const minKeepChars = config.toolResultHeadChars + config.toolResultTailChars;

  let totalToolResultChars = 0;
  let reducibleByMinKeep = 0;

  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const len = block.content.length;
      totalToolResultChars += len;
      reducibleByMinKeep += Math.max(0, len - minKeepChars);
    }
  }

  const reducibleByBudget = Math.max(0, totalToolResultChars - aggregateBudgetChars);
  return Math.min(reducibleByBudget, reducibleByMinKeep);
}

// ── 公共 API ────────────────────────────────────────────────

/**
 * 检查当前 messages + systemPrompt 是否超出上下文预算，并决定路由策略。
 *
 * 路由逻辑：
 *   1. overflowTokens == 0                    → fits
 *   2. reducibleChars >= truncateOnlyThreshold → truncate_tool_results_only
 *   3. 否则                                    → compact
 *
 * truncateOnlyThreshold = max(
 *   overflowTokens × CHARS_PER_TOKEN + TRUNCATION_BUFFER_TOKENS × CHARS_PER_TOKEN,
 *   ceil(overflowTokens × CHARS_PER_TOKEN × 1.5),
 * )
 *
 * 设计说明：messages 传入时不含当前用户消息；currentPrompt 作为独立字符串参数显式传入，
 * 单独计入 token 估算。reserveTokens 仅覆盖模型输出预留量，不代理当前消息体积。
 *
 * @param params.messages - 待发送的消息数组（不含当前用户消息，已经过 Layer 1 裁剪）
 * @param params.systemPrompt - system prompt 文本
 * @param params.currentPrompt - 当前用户消息字符串，独立传入，显式计入估算，不会被压缩
 * @param params.contextWindowTokens - 模型上下文窗口大小（tokens）
 * @param params.config - 压缩配置（reserveTokens / toolResultHeadChars / toolResultTailChars）
 * @returns 路由策略和估算数据
 */
export function checkContextBudget(params: {
  /** 历史消息（不含当前用户消息，已经过 Layer 1 裁剪） */
  messages: ChatMessage[];
  systemPrompt?: string;
  /** 当前用户消息字符串，独立传入，显式计入 token 估算，不会被压缩 */
  currentPrompt?: string;
  contextWindowTokens: number;
  config: Pick<CompactionConfig, 'reserveTokens' | 'toolResultHeadChars' | 'toolResultTailChars'>;
}): ContextBudgetResult {
  const { messages, systemPrompt, currentPrompt, contextWindowTokens, config } = params;

  const estimatedTokens = estimatePromptTokens({ messages, systemPrompt, currentPrompt });

  const availableTokens = Math.max(0, contextWindowTokens - config.reserveTokens);
  const overflowTokens = Math.max(0, estimatedTokens - availableTokens);

  const reducibleChars = estimateToolResultReductionPotential(
    messages,
    contextWindowTokens,
    config,
  );

  let route: ContextBudgetRoute;

  if (overflowTokens === 0) {
    route = 'fits';
  } else {
    const overflowChars = overflowTokens * CHARS_PER_TOKEN;
    const truncateOnlyThreshold = Math.max(
      overflowChars + TRUNCATION_BUFFER_TOKENS * CHARS_PER_TOKEN,
      Math.ceil(overflowChars * 1.5),
    );

    route = reducibleChars >= truncateOnlyThreshold ? 'truncate_tool_results_only' : 'compact';
  }

  return { route, estimatedTokens, availableTokens, overflowTokens, reducibleChars };
}
