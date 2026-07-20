import { describe, it, expect, vi } from 'vitest';
import { AnthropicClient } from './AnthropicClient.js';
import type { ChatParams, StreamEvent, ChatContentBlock } from './types.js';

// 注意：这些测试使用 mock，不需要真实 API Key

describe('AnthropicClient', () => {
  describe('constructor', () => {
    it('creates client with apiKey', () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      expect(client).toBeDefined();
    });

    it('creates client with baseURL', () => {
      const client = new AnthropicClient({
        apiKey: 'test-key',
        baseURL: 'http://localhost:4000',
      });
      expect(client).toBeDefined();
    });
  });

  describe('chat (with mock)', () => {
    it('collects text_delta events into a single text block', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      // Mock chatStream to yield predefined events
      const mockEvents: StreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      ];

      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.content).toHaveLength(1);
      expect(response.content[0]!.type).toBe('text');
      expect((response.content[0] as Extract<ChatContentBlock, { type: 'text' }>).text).toBe('Hello world');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
    });

    it('handles tool_use events', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const mockEvents: StreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Let me search.' },
        { type: 'tool_use', id: 'tool_01', name: 'search', input: { query: 'weather' } },
        { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 15 } },
      ];

      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Weather?' }],
      });

      expect(response.content).toHaveLength(2);
      expect(response.content[0]!.type).toBe('text');
      expect(response.content[1]!.type).toBe('tool_use');
      const toolBlock = response.content[1] as Extract<ChatContentBlock, { type: 'tool_use' }>;
      expect(toolBlock.name).toBe('search');
      expect(toolBlock.input).toEqual({ query: 'weather' });
      expect(response.stopReason).toBe('tool_use');
    });

    it('throws on error event', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const mockEvents: StreamEvent[] = [
        { type: 'message_start' },
        { type: 'error', error: new Error('API rate limit') },
      ];

      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      await expect(
        client.chat({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow('API rate limit');
    });

    it('handles empty response', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const mockEvents: StreamEvent[] = [
        { type: 'message_start' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 0 } },
      ];

      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: '' }],
      });

      expect(response.content).toHaveLength(0);
      expect(response.stopReason).toBe('end_turn');
    });

    it('handles text + tool_use + more text', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const mockEvents: StreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Before tool. ' },
        { type: 'tool_use', id: 'tool_01', name: 'read_file', input: { path: '/tmp/test' } },
        { type: 'text_delta', text: 'After tool.' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 20 } },
      ];

      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      const response = await client.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Read the file' }],
      });

      expect(response.content).toHaveLength(3);
      expect(response.content[0]!.type).toBe('text');
      expect((response.content[0] as Extract<ChatContentBlock, { type: 'text' }>).text).toBe('Before tool. ');
      expect(response.content[1]!.type).toBe('tool_use');
      expect(response.content[2]!.type).toBe('text');
      expect((response.content[2] as Extract<ChatContentBlock, { type: 'text' }>).text).toBe('After tool.');
    });
  });

  describe('outbound conversion', () => {
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
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' },
                dimensions: { width: 100, height: 100 },
              },
            ],
          },
        ],
      });

      expect(streamMock).toHaveBeenCalledOnce();
      const callArgs = streamMock.mock.calls[0]![0] as {
        messages: { content: Array<Record<string, unknown>> }[];
      };
      const sentBlock = callArgs.messages[0]!.content[0]!;
      expect(sentBlock.type).toBe('image');
      expect(sentBlock.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'abc' });
      expect('dimensions' in sentBlock).toBe(false);
    });
  });

  describe('chatStream (with mock)', () => {
    it('yields events in order', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const mockEvents: StreamEvent[] = [
        { type: 'message_start' },
        { type: 'text_delta', text: 'Hi' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
      ];

      vi.spyOn(client, 'chatStream').mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      const events: StreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]!.type).toBe('message_start');
      expect(events[1]!.type).toBe('text_delta');
      expect(events[2]!.type).toBe('message_end');
    });

    // core-abort-spec.md §11 —— signal 透传到 SDK 后，pre-aborted signal 应立即产出 error event。
    // 底层 SDK 使用 fetch，收到 pre-aborted signal 会抛 AbortError；chatStream 的 outer catch
    // 将其转成 { type: 'error', error }。
    it('yields error event when signal is already aborted', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      // 直接替换 SDK 的 messages.stream，模拟 SDK 在 signal 已 abort 时抛 AbortError。
      // 纯测试目的的 as-cast，等价于 mocking SDK 行为。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkClient = (client as any).client;
      const streamSpy = vi.spyOn(sdkClient.messages, 'stream');
      streamSpy.mockImplementation((..._args: unknown[]) => {
        // 模拟真实 SDK：signal 已 abort 时构造流即抛
        const opts = _args[1] as { signal?: AbortSignal } | undefined;
        if (opts?.signal?.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        throw new Error('unexpected: signal not aborted');
      });

      const controller = new AbortController();
      controller.abort();

      const events: StreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      })) {
        events.push(event);
      }

      // 应产出 error event，AgentRunner.callLLMStream 的 isAbortError 会识别并归 abort
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      const err = (errorEvent as Extract<StreamEvent, { type: 'error' }>).error;
      expect(err.name).toBe('AbortError');
    });
  });
});
