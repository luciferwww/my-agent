import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../llm-client/types.js';
import { checkContextBudget } from './context-budget.js';

describe('context-budget', () => {
  const contextWindowTokens = 1000;
  const baseConfig = {
    reserveTokens: 200,
    toolResultHeadChars: 200,
    toolResultTailChars: 100,
  };

  it('returns fits when messages are within budget', () => {
    // 小消息，远低于 800 available tokens
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
    ];
    const result = checkContextBudget({ messages, config: baseConfig, contextWindowTokens });

    expect(result.route).toBe('fits');
    expect(result.overflowTokens).toBe(0);
    expect(result.availableTokens).toBe(800);
  });

  it('returns compact when messages exceed budget', () => {
    // 大量内容，超出 800 available tokens，且无 tool result 可裁剪 → compact
    // 800 tokens ≈ 3200 chars (before safety margin), so ~2667 chars with 1.2x margin
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(4000) },
    ];
    const result = checkContextBudget({ messages, config: baseConfig, contextWindowTokens });

    expect(result.route).toBe('compact');
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeGreaterThan(result.availableTokens);
  });

  it('includes system prompt in token estimation', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
    ];
    const withoutSystem = checkContextBudget({ messages, config: baseConfig, contextWindowTokens });
    const withSystem = checkContextBudget({
      messages,
      systemPrompt: 'a'.repeat(4000),
      config: baseConfig,
      contextWindowTokens,
    });

    expect(withSystem.estimatedTokens).toBeGreaterThan(withoutSystem.estimatedTokens);
  });

  it('handles zero reserve tokens', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
    ];
    const config = { reserveTokens: 0, toolResultHeadChars: 200, toolResultTailChars: 100 };
    const result = checkContextBudget({ messages, config, contextWindowTokens });

    expect(result.availableTokens).toBe(1000);
    expect(result.route).toBe('fits');
  });

  it('handles edge case where available tokens is zero', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
    ];
    // reserveTokens >= contextWindow → availableTokens = 0
    const config = { reserveTokens: 200, toolResultHeadChars: 200, toolResultTailChars: 100 };
    const result = checkContextBudget({ messages, config, contextWindowTokens: 100 });

    expect(result.availableTokens).toBe(0);
    expect(result.route).toBe('compact');
  });

  it('returns correct overflow amount', () => {
    // 精确控制：2000 chars → 500 raw tokens → 600 with safety margin
    // available = 1000 - 200 = 800 → fits
    const fitsMessages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(2000) },
    ];
    const fitsResult = checkContextBudget({ messages: fitsMessages, config: baseConfig, contextWindowTokens });
    expect(fitsResult.route).toBe('fits');

    // 4000 chars → 1000 raw + 4 overhead → ~1205 with safety margin
    // available = 800 → overflow ≈ 405
    const overflowMessages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(4000) },
    ];
    const overflowResult = checkContextBudget({ messages: overflowMessages, config: baseConfig, contextWindowTokens });
    expect(overflowResult.route).toBe('compact');
    expect(overflowResult.overflowTokens).toBe(overflowResult.estimatedTokens - overflowResult.availableTokens);
  });

  it('routes to truncate_tool_results_only when tool results cover overflow', () => {
    // 数值推导：
    // contextWindowTokens = 10000, reserveTokens = 200 → availableTokens = 9800
    // tool result = 50000 chars → rawTokens ≈ 12515 → estimatedTokens ≈ 15018
    // overflowTokens = 5218, overflowChars = 20872
    // truncateOnlyThreshold = max(20872+2048, ceil(20872×1.5)) = max(22920, 31308) = 31308
    // aggregateBudgetChars = 10000×4×0.3 = 12000
    // reducibleChars = min(50000-12000, 50000-300) = min(38000, 49700) = 38000
    // 38000 >= 31308 → truncate_tool_results_only
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'x'.repeat(50_000) }],
      },
    ];
    const result = checkContextBudget({
      messages,
      config: { reserveTokens: 200, toolResultHeadChars: 200, toolResultTailChars: 100 },
      contextWindowTokens: 10_000,
    });

    expect(result.reducibleChars).toBeGreaterThan(0);
    expect(result.route).toBe('truncate_tool_results_only');
  });
});
