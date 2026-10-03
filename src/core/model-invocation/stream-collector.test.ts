import { describe, expect, it } from 'vitest';
import { ModelStreamCollector, projectContentForPresentation } from './stream-collector.js';

const source = {
  providerId: 'provider',
  connectionId: 'connection',
  requestModelId: 'model',
  wireProtocol: 'openai-responses' as const,
};

describe('ModelStreamCollector', () => {
  it('preserves interleaved Thinking and text order with stable persisted ids', () => {
    const collector = new ModelStreamCollector();
    collector.push({ type: 'message_start', invocation: { id: 'invocation-1', source } });
    collector.push({ type: 'thinking_start', blockId: 'thinking-0' });
    collector.push({ type: 'thinking_delta', blockId: 'thinking-0', text: 'considering' });
    collector.push({
      type: 'thinking_end',
      blockId: 'thinking-0',
      completion: {
        status: 'complete',
        text: 'considering',
        replay: { format: 'provider.reasoning.v1', payload: { opaque: 'secret' } },
      },
    });
    collector.push({ type: 'text_delta', text: 'answer' });
    collector.push({
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    expect(collector.finish()).toMatchObject({
      content: [
        {
          type: 'thinking',
          id: 'invocation-1:thinking-0',
          status: 'complete',
          text: 'considering',
          replay: { format: 'provider.reasoning.v1', payload: { opaque: 'secret' } },
        },
        { type: 'text', text: 'answer' },
      ],
      invocation: {
        id: 'invocation-1',
        source,
        completion: { status: 'complete', stopReason: 'end_turn' },
      },
    });
  });

  it('keeps readable partial Thinking but never invents replay state', () => {
    const collector = new ModelStreamCollector();
    collector.push({ type: 'message_start', invocation: { id: 'invocation-1', source } });
    collector.push({ type: 'thinking_start', blockId: 'thinking-0' });
    collector.push({ type: 'thinking_delta', blockId: 'thinking-0', text: 'partial' });

    expect(collector.finishPartial('aborted')).toMatchObject({
      content: [{
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'partial',
        text: 'partial',
      }],
      invocation: {
        completion: { status: 'partial', stopReason: 'aborted' },
      },
    });
  });

  it('removes Provider replay state and empty Thinking from presentation content', () => {
    expect(projectContentForPresentation([
      {
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'complete',
        text: 'visible',
        replay: { format: 'provider.reasoning.v1', payload: { opaque: 'secret' } },
      },
      {
        type: 'thinking',
        id: 'invocation-1:thinking-1',
        status: 'complete',
        text: '',
        replay: { format: 'provider.reasoning.v1', payload: { opaque: 'secret-2' } },
      },
      { type: 'text', text: 'answer' },
    ])).toEqual([
      {
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'complete',
        text: 'visible',
      },
      { type: 'text', text: 'answer' },
    ]);
  });
});
