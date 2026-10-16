import { describe, expect, it } from 'vitest';
import type { ChatMessage, InvocationSource } from '../../model-invocation/index.js';
import { checkContextBudget } from './context-budget.js';
import { filterIncompatibleThinking } from './filter-incompatible-thinking.js';

const target = {
  identity: { providerId: 'target', modelId: 'model' },
  endpointId: 'https://example.test/v1',
};

function assistant(source: Partial<InvocationSource> = {}): ChatMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        id: 'invocation:thinking-0',
        status: 'complete',
        text: '',
        replay: { format: 'test.reasoning.v1', payload: { opaque: 'private state' } },
      },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call', name: 'lookup', input: { id: 1 } },
    ],
    invocation: {
      id: 'invocation',
      source: {
        providerId: target.identity.providerId,
        requestModelId: target.identity.modelId,
        connectionId: target.endpointId,
        wireProtocol: 'openai-responses',
        ...source,
      },
      completion: {
        status: 'complete',
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
  };
}

describe('filterIncompatibleThinking', () => {
  it.each([
    { providerId: 'other' },
    { requestModelId: 'other' },
    { connectionId: 'https://other.test/v1' },
  ])('filters incompatible Thinking for %j without changing the input', (source) => {
    const message = assistant(source);
    const before = structuredClone(message);
    const result = filterIncompatibleThinking([message], target);
    expect(result).toEqual([{
      ...message,
      content: [
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call', name: 'lookup', input: { id: 1 } },
      ],
    }]);
    expect(message).toEqual(before);
    expect(result[0]).not.toBe(message);
  });

  it('preserves same-source opaque replay regardless of the response model alias', () => {
    const message = assistant({ responseModelId: 'model-snapshot' });
    expect(filterIncompatibleThinking([message], target)[0]).toBe(message);
  });

  it('filters Thinking with no invocation source', () => {
    const message = assistant();
    delete message.invocation;
    expect(filterIncompatibleThinking([message], target)[0]?.content).toEqual(
      Array.isArray(message.content) ? message.content.slice(1) : [],
    );
  });

  it('omits messages emptied by filtering and preserves other history in order', () => {
    const message = assistant({ providerId: 'other' });
    if (!Array.isArray(message.content)) throw new Error('Expected block content.');
    message.content = [message.content[0]!];
    const user: ChatMessage = { role: 'user', content: 'question' };
    const result: ChatMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result', status: 'success' }],
    };
    const text: ChatMessage = { role: 'assistant', content: 'answer' };
    const empty: ChatMessage = { role: 'assistant', content: [] };
    expect(filterIncompatibleThinking([user, message, result, text, empty], target))
      .toEqual([user, result, text, empty]);
  });

  it('also filters incompatible partial Thinking', () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', id: 'partial', status: 'partial', text: 'unfinished' }],
    };
    expect(filterIncompatibleThinking([message], target)).toEqual([]);
  });

  it('lets budgeting inspect exactly the projected replay state', () => {
    const budget = (messages: ChatMessage[]) => checkContextBudget({
      messages,
      inputBudgetTokens: 1000,
      config: { toolResultHeadChars: 200, toolResultTailChars: 100 },
    });
    const incompatible = assistant({ providerId: 'other' });
    expect(budget([incompatible]).route).toBe('unavailable');
    expect(budget(filterIncompatibleThinking([incompatible], target)).route).toBe('fits');
    expect(budget(filterIncompatibleThinking([assistant()], target)).route).toBe('unavailable');
  });
});
