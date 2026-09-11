import { describe, expect, it, vi } from 'vitest';
import {
  ContextOverflowError,
  ModelInvocationError,
} from '../../../core/model-invocation/index.js';
import type {
  ChatContentBlock,
  ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import { AnthropicClient } from './AnthropicClient.js';

describe('AnthropicClient', () => {
  describe('constructor', () => {
    it('creates client with apiKey', () => {
      expect(new AnthropicClient({ apiKey: 'test-key' })).toBeDefined();
    });

    it('creates client with baseURL', () => {
      expect(new AnthropicClient({
        apiKey: 'test-key',
        baseURL: 'http://localhost:4000',
      })).toBeDefined();
    });
  });

  describe('chat', () => {
    it('collects text_delta events into a single text block', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const mockEvents: ModelStreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      ];
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield* mockEvents;
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toHaveLength(1);
      expect((response.content[0] as Extract<ChatContentBlock, { type: 'text' }>).text)
        .toBe('Hello world');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it('handles tool_use events', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const mockEvents: ModelStreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Let me search.' },
        {
          type: 'tool_call',
          call: {
            callId: 'tool_01',
            name: 'search',
            input: { state: 'ready', value: { query: 'weather' } },
          },
        },
        { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 15 } },
      ];
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield* mockEvents;
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Weather?' }],
      });

      expect(response.content).toHaveLength(2);
      const toolBlock = response.content[1] as Extract<ChatContentBlock, { type: 'tool_use' }>;
      expect(toolBlock).toMatchObject({ name: 'search', input: { query: 'weather' } });
      expect(response.stopReason).toBe('tool_use');
    });

    it('throws on error event', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield { type: 'message_start' } as const;
        yield { type: 'error', error: new Error('API rate limit') } as const;
      });

      await expect(client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      })).rejects.toThrow('API rate limit');
    });

    it('handles empty response', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield { type: 'message_start' } as const;
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 0 },
        } as const;
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: '' }],
      });
      expect(response.content).toEqual([]);
      expect(response.stopReason).toBe('end_turn');
    });

    it('handles text + tool_use + more text', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const mockEvents: ModelStreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Before tool. ' },
        {
          type: 'tool_call',
          call: {
            callId: 'tool_01',
            name: 'read_file',
            input: { state: 'ready', value: { path: '/tmp/test' } },
          },
        },
        { type: 'text_delta', text: 'After tool.' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 20 } },
      ];
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield* mockEvents;
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Read the file' }],
      });

      expect(response.content).toHaveLength(3);
      expect((response.content[0] as Extract<ChatContentBlock, { type: 'text' }>).text)
        .toBe('Before tool. ');
      expect(response.content[1]!.type).toBe('tool_use');
      expect((response.content[2] as Extract<ChatContentBlock, { type: 'text' }>).text)
        .toBe('After tool.');
    });

    it('preserves invalid Tool input without creating an empty input block', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield { type: 'message_start' } as const;
        yield {
          type: 'tool_call',
          call: {
            callId: 'call-bad',
            name: 'search',
            input: { state: 'invalid', reason: 'malformed_json' },
          },
        } as const;
        yield {
          type: 'message_end',
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        } as const;
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Search' }],
      });

      expect(response.content).toEqual([]);
      expect(response.toolCalls).toEqual([{
        callId: 'call-bad',
        name: 'search',
        input: { state: 'invalid', reason: 'malformed_json' },
      }]);
    });
  });

  describe('outbound conversion', () => {
    it('normalizes malformed streamed Tool input without replacing it with an empty object', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const sdkEvents = [
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'call-bad', name: 'search', input: {} },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"query":' },
        },
        { type: 'content_block_stop' },
      ];
      const fakeStream = {
        async *[Symbol.asyncIterator]() {
          yield* sdkEvents;
        },
        finalMessage: async () => ({
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
      const streamMock = vi.fn().mockReturnValue(fakeStream);
      (client as unknown as { client: { messages: { stream: typeof streamMock } } }).client = {
        messages: { stream: streamMock },
      };

      const events: ModelStreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Search' }],
      })) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: 'tool_call',
        call: {
          callId: 'call-bad',
          name: 'search',
          input: { state: 'invalid', reason: 'malformed_json' },
        },
      });
      expect(streamMock.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 1024 });
    });

    it('strips dimensions from image blocks when calling the SDK', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const fakeStream: AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> } = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { value: undefined, done: true };
            },
          };
        },
        finalMessage: async () => ({
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      };
      const streamMock = vi.fn().mockReturnValue(fakeStream);
      (client as unknown as { client: { messages: { stream: typeof streamMock } } }).client = {
        messages: { stream: streamMock },
      };

      await client.chat({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc' },
            dimensions: { width: 100, height: 100 },
          }],
        }],
      });

      const callArgs = streamMock.mock.calls[0]![0] as {
        messages: { content: Array<Record<string, unknown>> }[];
      };
      const sentBlock = callArgs.messages[0]!.content[0]!;
      expect(sentBlock.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'abc' });
      expect('dimensions' in sentBlock).toBe(false);
    });
  });

  describe('chatStream', () => {
    it('yields events in order', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const mockEvents: ModelStreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Hi' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
      ];
      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        yield* mockEvents;
      });

      const events: ModelStreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        events.push(event);
      }
      expect(events.map((event) => event.type))
        .toEqual(['message_start', 'text_delta', 'message_end']);
    });

    it('yields an AbortError when the signal is already aborted', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const sdkClient = (client as unknown as {
        client: { messages: { stream: (...args: unknown[]) => unknown } };
      }).client;
      vi.spyOn(sdkClient.messages, 'stream').mockImplementation((...args: unknown[]) => {
        const options = args[1] as { signal?: AbortSignal } | undefined;
        if (options?.signal?.aborted) {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
        throw new Error('unexpected: signal not aborted');
      });
      const controller = new AbortController();
      controller.abort();

      const events: ModelStreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      })) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === 'error');
      expect(errorEvent?.type === 'error' ? errorEvent.error.name : undefined).toBe('AbortError');
    });

    it('normalizes Provider context overflow to the Core error type', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const sdkClient = (client as unknown as {
        client: { messages: { stream: (...args: unknown[]) => unknown } };
      }).client;
      vi.spyOn(sdkClient.messages, 'stream').mockImplementation(() => {
        throw new Error('request_too_large: prompt exceeds limit');
      });

      const events: ModelStreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === 'error');
      expect(errorEvent?.type === 'error' ? errorEvent.error : undefined)
        .toBeInstanceOf(ContextOverflowError);
    });

    it('normalizes other Provider SDK failures without exposing the raw error', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      const sdkClient = (client as unknown as {
        client: { messages: { stream: (...args: unknown[]) => unknown } };
      }).client;
      const providerError = Object.assign(new Error('secret provider response'), {
        status: 429,
        type: 'rate_limit_error',
        requestID: 'req-diagnostic-1',
        error: {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: '  rate limit reached  ',
          },
        },
      });
      vi.spyOn(sdkClient.messages, 'stream').mockImplementation(() => {
        throw providerError;
      });

      const events: ModelStreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-5',
        maxTokens: 1024,
        system: 'secret system prompt',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'secret user prompt' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'secret base64 image',
                },
                dimensions: { width: 10, height: 20 },
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'secret tool result',
              },
            ],
          },
          {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'tool-1',
              name: 'secret_tool_name',
              input: { secret: 'tool input' },
            }],
          },
        ],
        tools: [{
          name: 'secret_tool_name',
          description: 'secret tool description',
          inputSchema: { type: 'object', secretSchema: true },
        }],
      })) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === 'error');
      const error = errorEvent?.type === 'error' ? errorEvent.error : undefined;
      expect(error).toBeInstanceOf(ModelInvocationError);
      expect((error as ModelInvocationError).category).toBe('rate_limit');
      expect(error?.message).not.toContain('secret provider response');
      expect((error as ModelInvocationError).diagnostics).toEqual({
        providerId: 'anthropic-compatible',
        httpStatus: 429,
        providerErrorType: 'rate_limit_error',
        providerMessage: 'rate limit reached',
        requestId: 'req-diagnostic-1',
        request: {
          model: 'claude-sonnet-5',
          maxTokens: 1024,
          hasSystem: true,
          messageCount: 2,
          userMessageCount: 1,
          assistantMessageCount: 1,
          stringContentMessageCount: 0,
          textBlockCount: 1,
          imageBlockCount: 1,
          toolUseBlockCount: 1,
          toolResultBlockCount: 1,
          toolDefinitionCount: 1,
        },
      });
      expect(JSON.stringify((error as ModelInvocationError).diagnostics)).not.toMatch(
        /secret provider|secret system|secret user|secret base64|secret tool|tool input|secretSchema/,
      );
    });
  });
});
