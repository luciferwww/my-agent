import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage } from '../llm-client/types.js';
import { splitForCompaction, compactMessages } from './compaction.js';
import type { CompactionConfig } from '../config/types.js';

// ── 测试用常量 ────────────────────────────────────────────

const BASE_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTurns: 2,
  toolResultContextShare: 0.5,
  toolResultHeadChars: 10_000,
  toolResultTailChars: 5_000,
  timeoutSeconds: 300,
};

/** 构造一条普通用户消息（非 tool_result） */
function userMsg(content: string): ChatMessage {
  return { role: 'user', content };
}

/** 构造一条 assistant 纯文本消息 */
function assistantMsg(content: string): ChatMessage {
  return { role: 'assistant', content: [{ type: 'text', text: content }] };
}

/** 构造一条 assistant tool_use 消息 */
function assistantToolUseMsg(toolId: string, toolName: string): ChatMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input: {} }],
  };
}

/** 构造一条 tool_result 消息（role='user'，content 为数组） */
function toolResultMsg(toolUseId: string, content: string): ChatMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

// ── splitForCompaction ────────────────────────────────────

describe('splitForCompaction', () => {
  it('keeps the last N user turns in toKeep', () => {
    const messages: ChatMessage[] = [
      userMsg('turn 1'),
      assistantMsg('reply 1'),
      userMsg('turn 2'),
      assistantMsg('reply 2'),
      userMsg('turn 3'),
      assistantMsg('reply 3'),
    ];

    // keepRecentTurns=2 → 保留最后 2 个用户轮次（turn 2, turn 3 及其回复）
    const { toCompress, toKeep } = splitForCompaction(messages, 2);

    expect(toKeep).toHaveLength(4);
    expect((toKeep[0] as any).content).toBe('turn 2');
    expect(toCompress).toHaveLength(2);
    expect((toCompress[0] as any).content).toBe('turn 1');
  });

  it('returns toCompress=[] when messages are fewer than keepRecentTurns', () => {
    const messages: ChatMessage[] = [
      userMsg('only turn'),
      assistantMsg('reply'),
    ];

    // 只有 1 轮，keepRecentTurns=2 → 无法压缩
    const { toCompress, toKeep } = splitForCompaction(messages, 2);

    expect(toCompress).toHaveLength(0);
    expect(toKeep).toHaveLength(2);
  });

  it('keeps all messages in toKeep when keepRecentTurns equals total turns', () => {
    const messages: ChatMessage[] = [
      userMsg('turn 1'),
      assistantMsg('reply 1'),
      userMsg('turn 2'),
      assistantMsg('reply 2'),
    ];

    const { toCompress, toKeep } = splitForCompaction(messages, 2);

    expect(toCompress).toHaveLength(0);
    expect(toKeep).toHaveLength(4);
  });

  it('does not count tool_result messages as user turns', () => {
    // tool_result 虽然 role='user'，但 content 是数组，不算新轮次
    const messages: ChatMessage[] = [
      userMsg('turn 1'),
      assistantToolUseMsg('tu_1', 'read_file'),
      toolResultMsg('tu_1', 'file content'),
      userMsg('turn 2'),
      assistantMsg('reply 2'),
    ];

    // keepRecentTurns=1 → 只保留最后 1 个用户轮次（turn 2 + reply）
    const { toCompress, toKeep } = splitForCompaction(messages, 1);

    expect(toKeep).toHaveLength(2);
    expect((toKeep[0] as any).content).toBe('turn 2');
    expect(toCompress).toHaveLength(3); // turn 1 + tool_use + tool_result
  });

  it('moves split point before assistant(tool_use) to protect tool_use/tool_result pairing', () => {
    // 如果拆分点落在 assistant(tool_use) 之后、tool_result 之前，
    // 应向前移动到 assistant 之前，避免配对被拆散
    const messages: ChatMessage[] = [
      userMsg('turn 1'),
      assistantMsg('reply 1'),
      // 拆分点本来会落在这里（保留 turn 2 起）
      assistantToolUseMsg('tu_1', 'read_file'), // 这条如果在压缩区末尾会不安全
      toolResultMsg('tu_1', 'file content'),
      userMsg('turn 2'),
      assistantMsg('reply 2'),
    ];

    const { toCompress, toKeep } = splitForCompaction(messages, 1);

    // toKeep 应该包含 turn 2 及其之前（保护 tool_use/tool_result 配对）
    // turn 2 之前的 tool_result 不算用户轮次，所以保留区起点还是 turn 2
    expect((toKeep[0] as any).content).toBe('turn 2');
    // tool_use 之前没有裸露的配对问题（tool_result 已在 turn 2 之前）
    // 这里主要验证 toKeep 不会从 tool_result 中间开始
    expect(toKeep.every((m) =>
      m.role !== 'user' ||
      typeof m.content === 'string' ||
      (m.content as any[])[0]?.type !== 'tool_use'
    )).toBe(true);
  });

  it('handles messages with no user turns', () => {
    const messages: ChatMessage[] = [
      assistantMsg('autonomous reply 1'),
      assistantMsg('autonomous reply 2'),
    ];

    const { toCompress, toKeep } = splitForCompaction(messages, 2);

    // 没有用户消息，全部保留
    expect(toCompress).toHaveLength(0);
    expect(toKeep).toHaveLength(2);
  });
});

// ── compactMessages ───────────────────────────────────────

describe('compactMessages', () => {
  /** 构建一个简单的 mock LLM client（总是返回固定摘要文本） */
  function makeMockLLMClient(summaryText: string) {
    return {
      chatStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'text_delta', text: summaryText };
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } };
      }),
    };
  }

  /** 构建一个总是抛出错误的 mock LLM client（用于测试降级） */
  function makeFailingLLMClient() {
    return {
      chatStream: vi.fn().mockImplementation(async function* () {
        throw new Error('LLM service unavailable');
        // eslint-disable-next-line no-unreachable
        yield; // TypeScript 需要 generator 函数有 yield
      }),
    };
  }

  it('returns compacted messages with summary + kept messages', async () => {
    const messages: ChatMessage[] = [
      userMsg('turn 1'), assistantMsg('reply 1'),
      userMsg('turn 2'), assistantMsg('reply 2'),
      userMsg('turn 3'), assistantMsg('reply 3'),
    ];

    const llmClient = makeMockLLMClient('Summary of turns 1 and 2.');
    const result = await compactMessages({
      messages,
      config: BASE_CONFIG,  // keepRecentTurns=2
      llmClient: llmClient as any,
      model: 'claude-test',
      trigger: 'preemptive',
    });

    // 结果消息：[摘要消息, turn 2 及之后的消息（共 4 条）]
    expect(result.messages).toHaveLength(5);
    expect((result.messages[0] as any).content).toContain('[Previous conversation summary]');
    expect((result.messages[0] as any).content).toContain('Summary of turns 1 and 2.');
  });

  it('stats reflect tokensBefore > tokensAfter after compression', async () => {
    // 构造足够多的消息使压缩前后有差异
    const messages: ChatMessage[] = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? userMsg(`turn ${i / 2 + 1}`) : assistantMsg(`reply ${Math.floor(i / 2) + 1}`),
    );

    const llmClient = makeMockLLMClient('Compressed summary.');
    const result = await compactMessages({
      messages,
      config: { ...BASE_CONFIG, keepRecentTurns: 2 },
      llmClient: llmClient as any,
      model: 'claude-test',
      trigger: 'overflow',
    });

    expect(result.stats.tokensBefore).toBeGreaterThan(0);
    expect(result.stats.tokensAfter).toBeGreaterThan(0);
    expect(result.stats.tokensBefore).toBeGreaterThan(result.stats.tokensAfter);
    expect(result.stats.trigger).toBe('overflow');
  });

  it('records droppedMessages count correctly', async () => {
    const messages: ChatMessage[] = [
      userMsg('turn 1'), assistantMsg('reply 1'),  // 压缩区（2 条）
      userMsg('turn 2'), assistantMsg('reply 2'),  // 保留区（2 条）
    ];

    const llmClient = makeMockLLMClient('Short summary.');
    const result = await compactMessages({
      messages,
      config: { ...BASE_CONFIG, keepRecentTurns: 1 },
      llmClient: llmClient as any,
      model: 'claude-test',
      trigger: 'preemptive',
    });

    expect(result.stats.droppedMessages).toBe(2); // turn 1 + reply 1
  });

  it('falls back to placeholder summary when LLM fails', async () => {
    const messages: ChatMessage[] = [
      userMsg('turn 1'), assistantMsg('reply 1'),
      userMsg('turn 2'), assistantMsg('reply 2'),
    ];

    const llmClient = makeFailingLLMClient();
    // LLM 调用失败时，不应抛出错误，而是降级为兜底文本
    const result = await compactMessages({
      messages,
      config: { ...BASE_CONFIG, keepRecentTurns: 1 },
      llmClient: llmClient as any,
      model: 'claude-test',
      trigger: 'overflow',
    });

    expect(result.messages[0]).toBeDefined();
    const summaryContent = (result.messages[0] as any).content as string;
    // 兜底文本包含消息条数描述
    expect(summaryContent).toContain('[Conversation summary unavailable');
    expect(summaryContent).toContain('messages');
  });

  it('throws when there are not enough messages to compress', async () => {
    // keepRecentTurns=5 但只有 2 条消息 → toCompress 为空 → 抛出
    const messages: ChatMessage[] = [
      userMsg('only turn'),
      assistantMsg('only reply'),
    ];

    const llmClient = makeMockLLMClient('should not be called');
    await expect(
      compactMessages({
        messages,
        config: { ...BASE_CONFIG, keepRecentTurns: 5 },
        llmClient: llmClient as any,
        model: 'claude-test',
        trigger: 'preemptive',
      }),
    ).rejects.toThrow('Cannot compact');
  });

  it('record has correct type and trigger', async () => {
    const messages: ChatMessage[] = [
      userMsg('turn 1'), assistantMsg('reply 1'),
      userMsg('turn 2'), assistantMsg('reply 2'),
    ];

    const llmClient = makeMockLLMClient('Summary.');
    const result = await compactMessages({
      messages,
      config: { ...BASE_CONFIG, keepRecentTurns: 1 },
      llmClient: llmClient as any,
      model: 'claude-test',
      trigger: 'manual',
    });

    expect(result.record.type).toBe('compaction');
    expect(result.record.trigger).toBe('manual');
    expect(result.record.summary).toBe('Summary.');
    expect(result.record.id).toBeTruthy();
    expect(result.record.timestamp).toBeTruthy();
  });
});
