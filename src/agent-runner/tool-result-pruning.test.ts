import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../llm-client/types.js';
import { pruneToolResults, type PruneInfo } from './tool-result-pruning.js';

/** 创建包含 tool_result 的 user 消息（Anthropic API 格式） */
function makeToolResultMessage(content: string, toolUseId = 'tu_1'): ChatMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

// maxChars = contextWindowTokens × TOOL_RESULT_CHARS_PER_TOKEN × toolResultContextShare
//          = 100 × 2 × 0.5 = 100 字符
const TEST_CONTEXT_WINDOW_TOKENS = 100;

const defaultConfig = {
  toolResultContextShare: 0.5,
  toolResultHeadChars: 30,
  toolResultTailChars: 20,
};

describe('tool-result-pruning', () => {
  it('does not prune short tool results', () => {
    const msg = makeToolResultMessage('short content');
    const messages = [msg];
    const result = pruneToolResults(messages, defaultConfig, TEST_CONTEXT_WINDOW_TOKENS);
    // 内容未超限，返回原数组引用
    expect(result).toBe(messages);
  });

  it('prunes long tool results', () => {
    const content = 'a'.repeat(200);
    const msg = makeToolResultMessage(content);
    const result = pruneToolResults([msg], defaultConfig, TEST_CONTEXT_WINDOW_TOKENS);

    expect(result).not.toBe([msg]); // 返回新数组
    const block = (result[0].content as any[])[0];
    expect(block.type).toBe('tool_result');
    // 裁剪后应包含头部、省略标记、尾部、裁剪说明
    expect(block.content).toContain('a'.repeat(30));
    expect(block.content).toContain('...');
    expect(block.content).toContain('[Tool result trimmed:');
    expect(block.content.length).toBeLessThan(content.length);
  });

  it('preserves non-tool-result messages unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const result = pruneToolResults(messages, defaultConfig, TEST_CONTEXT_WINDOW_TOKENS);
    expect(result).toBe(messages); // 无修改，返回原引用
  });

  it('only prunes tool results that exceed maxChars', () => {
    const short = makeToolResultMessage('short', 'tu_1');
    const long = makeToolResultMessage('x'.repeat(200), 'tu_2');
    const result = pruneToolResults([short, long], defaultConfig, TEST_CONTEXT_WINDOW_TOKENS);

    // short 不变
    expect((result[0].content as any[])[0].content).toBe('short');
    // long 被裁剪
    expect((result[1].content as any[])[0].content).toContain('[Tool result trimmed:');
  });

  it('calls onPruned callback for each pruned result', () => {
    const infos: PruneInfo[] = [];
    const content = 'z'.repeat(200);
    const msg = makeToolResultMessage(content);

    pruneToolResults([msg], defaultConfig, TEST_CONTEXT_WINDOW_TOKENS, (info) => infos.push(info));

    expect(infos).toHaveLength(1);
    expect(infos[0].index).toBe(0);
    expect(infos[0].toolUseId).toBe('tu_1');
    expect(infos[0].originalChars).toBe(200);
    expect(infos[0].prunedChars).toBeLessThan(200);
  });

  it('does not modify the original messages array', () => {
    const content = 'a'.repeat(200);
    const msg = makeToolResultMessage(content);
    const original = [msg];
    pruneToolResults(original, defaultConfig, TEST_CONTEXT_WINDOW_TOKENS);

    // 原始消息不受影响
    expect((original[0].content as any[])[0].content).toBe(content);
  });

  it('returns original array reference when nothing is pruned', () => {
    const messages: ChatMessage[] = [
      makeToolResultMessage('short'),
      { role: 'user', content: 'hello' },
    ];
    const result = pruneToolResults(messages, defaultConfig, TEST_CONTEXT_WINDOW_TOKENS);
    expect(result).toBe(messages);
  });

  it('computes maxChars dynamically from contextWindowTokens', () => {
    // 200k 窗口 → maxChars = 200_000 × 2 × 0.5 = 200_000，不应触发裁剪
    const content = 'a'.repeat(50_000);
    const msg = makeToolResultMessage(content);
    const input = [msg];
    const result = pruneToolResults(input, defaultConfig, 200_000);
    expect(result).toBe(input); // 未超限，返回原数组引用
  });
});
