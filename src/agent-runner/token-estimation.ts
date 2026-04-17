/**
 * Token 估算工具。
 *
 * 使用 chars/4 启发式估算（对英文约 80% 准确，对 CJK 偏低但安全方向）。
 * 乘以 SAFETY_MARGIN 补偿估算误差，确保不会因低估导致溢出。
 *
 * 参考 OpenClaw compaction.ts 中的 estimateTokens / SAFETY_MARGIN 设计。
 */

import type { ChatMessage, ChatContentBlock } from '../llm-client/types.js';

// ── 常量 ────────────────────────────────────────────────────

/** 安全边际：补偿 chars/4 对多字节字符、特殊 token、序列化开销的低估 */
export const SAFETY_MARGIN = 1.2;

/** 每条消息的固定开销（role 标签、格式化 token 等） */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** 图片内容的固定 token 估算值 */
const IMAGE_TOKEN_ESTIMATE = 2000;

/** chars / CHARS_PER_TOKEN = 粗略 token 数 */
const CHARS_PER_TOKEN = 4;

// ── 内部工具 ────────────────────────────────────────────────

/** 估算纯文本的 token 数（不含安全边际） */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 估算单个 ContentBlock 的 token 数（不含安全边际） */
function estimateBlockTokens(block: ChatContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'tool_use':
      // tool name + JSON.stringify(input)
      try {
        return estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input));
      } catch {
        return 128; // fallback for non-serializable input
      }
    case 'tool_result':
      return estimateTextTokens(block.content);
    case 'image':
      return IMAGE_TOKEN_ESTIMATE;
    default:
      return 0;
  }
}

// ── 公共 API ────────────────────────────────────────────────

/**
 * 估算单条消息的 token 数。
 *
 * 包含消息内容 + 消息格式开销，不含安全边际（由调用方决定是否乘 SAFETY_MARGIN）。
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  if (typeof message.content === 'string') {
    tokens += estimateTextTokens(message.content);
  } else {
    for (const block of message.content) {
      tokens += estimateBlockTokens(block);
    }
  }

  return tokens;
}

/**
 * 估算完整 prompt 的 token 数（system prompt + messages + 当前用户消息）。
 *
 * currentPrompt 独立传入，不纳入 messages（不会被压缩），单独计入 token 估算。
 * 返回值已乘以 SAFETY_MARGIN，可直接与 contextWindowTokens 比较。
 */
export function estimatePromptTokens(params: {
  messages: ChatMessage[];
  systemPrompt?: string;
  /** 当前用户消息字符串，独立传入，显式计入 token 估算，不会被压缩 */
  currentPrompt?: string;
}): number {
  let rawTokens = 0;

  // system prompt
  if (params.systemPrompt) {
    rawTokens += estimateTextTokens(params.systemPrompt);
  }

  // messages
  for (const msg of params.messages) {
    rawTokens += estimateMessageTokens(msg);
  }

  // 当前用户消息（独立计入，不合入 messages）
  if (params.currentPrompt) {
    rawTokens += estimateTextTokens(params.currentPrompt) + MESSAGE_OVERHEAD_TOKENS;
  }

  // 乘以安全边际并向上取整
  return Math.ceil(rawTokens * SAFETY_MARGIN);
}
