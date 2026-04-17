/**
 * 对话压缩核心逻辑（Layer 3）。
 *
 * 当上下文超出预算且无法通过裁剪解决时，调用 LLM 对历史消息生成摘要，
 * 用摘要替换旧消息，只保留最近 N 轮的完整消息记录。
 *
 * 压缩不修改 JSONL 文件，而是返回 CompactionResult，
 * 由 AgentRunner.compactHistory() 负责写入持久化。
 */

import { randomUUID } from 'crypto';
import type { ChatMessage } from '../llm-client/types.js';
import type { LLMClient } from '../llm-client/types.js';
import type { CompactionConfig } from '../config/types.js';
import type { CompactionRecord } from '../session/types.js';
import { estimatePromptTokens } from './token-estimation.js';

// ── 类型 ────────────────────────────────────────────────────

/** 压缩操作的结果，由 compactMessages() 返回 */
export interface CompactionResult {
  /**
   * 压缩后的 messages 数组。
   * 结构：[摘要消息（user role）, ...保留区的近期消息]
   * AgentRunner 在下次 runAttempt 时通过 loadHistory() 重新加载，
   * 此处的 messages 不直接写入 session，而是用 record 持久化。
   */
  messages: ChatMessage[];
  /** 压缩统计数据，用于事件上报和 CompactionRecord 写入 */
  stats: {
    tokensBefore: number;
    tokensAfter: number;
    /** 被摘要替代的消息条数（压缩区消息数） */
    droppedMessages: number;
    trigger: 'preemptive' | 'overflow' | 'manual';
  };
  /**
   * 用于持久化到 JSONL 的压缩记录。
   * firstKeptEntryId 需由调用方（AgentRunner）填入，
   * 因为 compaction.ts 不感知消息 ID，只处理内容。
   */
  record: Omit<CompactionRecord, 'firstKeptEntryId'>;
}

// ── 消息拆分 ────────────────────────────────────────────────

/**
 * 将 messages 数组拆分为"压缩区"和"保留区"。
 *
 * 保留区：从末尾数 keepRecentTurns 个用户轮次（user 消息）及其后续消息。
 * 压缩区：保留区之前的所有消息。
 *
 * "轮次"定义：一条 role='user' 消息（不含 tool_result）算一轮的起点。
 * 注意：tool_result 消息在 API 层也是 role='user'，但它不是对话轮次的起点。
 * 这里通过 content 类型（string = 普通用户消息）来区分。
 *
 * 安全保护：如果拆分点落在 assistant(tool_use) 之后、tool_result 之前，
 * 则向前移动到该 assistant 消息之前，确保 tool_use/tool_result 配对不被拆散。
 */
export function splitForCompaction(
  messages: ChatMessage[],
  keepRecentTurns: number,
): { toCompress: ChatMessage[]; toKeep: ChatMessage[] } {
  // 从末尾反向扫描，计数普通用户消息（非 tool_result）的轮次
  let userTurnCount = 0;
  // 默认：全部保留（不压缩）。
  // 若消息数不足 keepRecentTurns 轮，循环不会 break，splitIndex 保持 0，
  // 结果为 toCompress=[] / toKeep=all，使 compactMessages 抛出 CannotCompact。
  let splitIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // 识别普通用户消息：role='user' 且 content 为字符串
    // tool_result 消息的 content 是 ContentBlock 数组，不算一个新轮次
    if (msg.role === 'user' && typeof msg.content === 'string') {
      userTurnCount++;
      if (userTurnCount === keepRecentTurns) {
        // 找到第 keepRecentTurns 个用户消息，此处开始为保留区
        splitIndex = i;
        break;
      }
    }
  }

  // 安全检查：避免在 tool_use / tool_result 之间切割
  // 如果 splitIndex 处的前一条消息是 assistant 且含 tool_use block，
  // 则向前移动 splitIndex 到该 assistant 消息之前
  if (splitIndex > 0) {
    const prevMsg = messages[splitIndex - 1];
    if (
      prevMsg.role === 'assistant' &&
      Array.isArray(prevMsg.content) &&
      prevMsg.content.some((b) => (b as { type: string }).type === 'tool_use')
    ) {
      // 找到对应的 tool_use assistant 消息，将其移入保留区
      splitIndex -= 1;
    }
  }

  return {
    toCompress: messages.slice(0, splitIndex),
    toKeep: messages.slice(splitIndex),
  };
}

// ── 摘要生成 ────────────────────────────────────────────────

/**
 * 将消息数组序列化为可读的对话文本，供 LLM 摘要。
 *
 * 格式：
 *   [User]: 消息内容
 *   [Assistant]: 消息内容
 *   [Tool Result]: 工具返回内容（截取前 500 字符，避免摘要 prompt 过长）
 */
function serializeMessagesForSummary(messages: ChatMessage[]): string {
  const MAX_TOOL_RESULT_CHARS = 500;
  const parts: string[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(`[User]: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as { type: string; text?: string; content?: string; name?: string };
        if (b.type === 'text' && b.text) {
          const prefix = msg.role === 'user' ? '[User]' : '[Assistant]';
          parts.push(`${prefix}: ${b.text}`);
        } else if (b.type === 'tool_use' && b.name) {
          parts.push(`[Tool Use]: ${b.name}`);
        } else if (b.type === 'tool_result' && b.content) {
          const preview = b.content.length > MAX_TOOL_RESULT_CHARS
            ? b.content.slice(0, MAX_TOOL_RESULT_CHARS) + '...[truncated]'
            : b.content;
          parts.push(`[Tool Result]: ${preview}`);
        }
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * 调用 LLM 对压缩区消息生成摘要。
 *
 * 两级降级策略：
 *   Level 1：正常调用 LLM 生成摘要
 *   Level 2：LLM 调用失败时，返回兜底文本（保留关键统计信息，不丢失完整性感知）
 *
 * 兜底文本不是"报错"，而是一段对后续 LLM 有意义的上下文描述，
 * 避免因摘要失败导致整个压缩流程中断。
 */
async function generateSummary(params: {
  messages: ChatMessage[];
  llmClient: LLMClient;
  model: string;
  customInstructions?: string;
}): Promise<string> {
  const { messages, llmClient, model, customInstructions } = params;

  const conversationText = serializeMessagesForSummary(messages);
  const messageCount = messages.length;

  // 构建摘要 prompt
  const summaryPrompt = [
    'Please provide a concise summary of the following conversation.',
    'Focus on: key decisions made, important findings, current task state, and any critical context needed to continue.',
    'Keep the summary under 500 words.',
    ...(customInstructions ? [customInstructions] : []),
    '',
    '<conversation>',
    conversationText,
    '</conversation>',
    '',
    'Summarize this conversation.',
  ].join('\n');

  try {
    // 使用非流式风格：收集所有 text_delta 拼成完整摘要
    let summary = '';
    for await (const event of llmClient.chatStream({
      model,
      messages: [{ role: 'user', content: summaryPrompt }],
      maxTokens: 1024,
    })) {
      if (event.type === 'text_delta') {
        summary += event.text;
      }
    }
    return summary.trim() || buildFallbackSummary(messageCount);
  } catch {
    // LLM 调用失败时返回兜底文本，不向上抛出
    return buildFallbackSummary(messageCount);
  }
}

/**
 * 兜底摘要文本。
 * 当 LLM 摘要生成失败时使用，保持对后续对话有一定的上下文提示价值。
 */
function buildFallbackSummary(messageCount: number): string {
  return (
    `[Conversation summary unavailable. ` +
    `Prior conversation contained ${messageCount} messages. ` +
    `Recent context preserved below.]`
  );
}

// ── 完整压缩流程 ────────────────────────────────────────────

/**
 * 对话压缩主函数。
 *
 * 流程：
 *   1. 计算压缩前 token 数（tokensBefore）
 *   2. 按 keepRecentTurns 拆分为压缩区和保留区
 *   3. 压缩区为空（消息太少）→ 抛出 CompactionError，不执行压缩
 *   4. 调用 LLM 生成摘要（失败时降级为兜底文本）
 *   5. 构建压缩后 messages：[摘要消息, ...保留区消息]
 *   6. 计算压缩后 token 数（tokensAfter）
 *   7. 返回 CompactionResult（不写持久化，由调用方决定）
 */
export async function compactMessages(params: {
  messages: ChatMessage[];
  config: CompactionConfig;
  llmClient: LLMClient;
  model: string;
  trigger: 'preemptive' | 'overflow' | 'manual';
}): Promise<CompactionResult> {
  const { messages, config, llmClient, model, trigger } = params;

  // 压缩前 token 估算
  const tokensBefore = estimatePromptTokens({ messages });

  // 拆分压缩区和保留区
  const { toCompress, toKeep } = splitForCompaction(messages, config.keepRecentTurns);

  // 压缩区为空：消息太少，无法压缩（至少需要有一条消息可以被摘要）
  if (toCompress.length === 0) {
    throw new Error(
      `Cannot compact: not enough messages to compress ` +
      `(total=${messages.length}, keepRecentTurns=${config.keepRecentTurns})`,
    );
  }

  // 生成摘要（LLM 调用，失败时降级为兜底文本）
  const summary = await generateSummary({
    messages: toCompress,
    llmClient,
    model,
    customInstructions: config.customInstructions,
  });

  // 构建压缩后 messages：摘要作为第一条 user 消息，后接保留区完整消息
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `[Previous conversation summary]\n\n${summary}\n\n[End of summary. The conversation continues below.]`,
  };
  const compactedMessages: ChatMessage[] = [summaryMessage, ...toKeep];

  // 压缩后 token 估算
  const tokensAfter = estimatePromptTokens({ messages: compactedMessages });

  // 构建持久化记录（firstKeptEntryId 由调用方填入，因为 compaction.ts 不感知消息 ID）
  const record: Omit<CompactionRecord, 'firstKeptEntryId'> = {
    type: 'compaction',
    id: randomUUID(),
    parentId: null, // 由 appendCompactionRecord 填入当前 leafId
    timestamp: new Date().toISOString(),
    summary,
    tokensBefore,
    tokensAfter,
    trigger,
    droppedMessages: toCompress.length,
  };

  return {
    messages: compactedMessages,
    stats: {
      tokensBefore,
      tokensAfter,
      droppedMessages: toCompress.length,
      trigger,
    },
    record,
  };
}
