import { describe, expect, it, vi } from 'vitest';
import {
  ContextOverflowError,
  ModelInvocationError,
  type ModelInvocationPort,
  type ModelInvocationRequest,
  type ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import { AnthropicMessagesClient } from './AnthropicMessagesClient.js';
import { OpenAIChatCompletionsClient } from './OpenAIChatCompletionsClient.js';
import { OpenAIResponsesClient } from './OpenAIResponsesClient.js';

const request: ModelInvocationRequest = {
  model: 'opaque/model:1',
  system: 'system',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
        dimensions: { width: 1, height: 1 },
      },
    ],
  }],
  tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
};

describe('Built-in Protocol Clients', () => {
  it('parses CR-only SSE framing', async () => {
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        crFrame({ type: 'response.created' })
        + crFrame({ type: 'response.output_text.delta', delta: 'cr' })
        + crFrame({
          type: 'response.completed',
          response: { usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      )) as unknown as typeof fetch,
    });

    await expect(client.chat(request)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'cr' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it('parses an SSE delimiter split across chunks', async () => {
    const encoded = new TextEncoder();
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => chunkedSse([
        encoded.encode(`data: ${JSON.stringify({ type: 'response.created' })}\r`),
        encoded.encode('\n\r'),
        encoded.encode(`\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: { usage: { input_tokens: 2, output_tokens: 0 } },
        })}\r\n`),
        encoded.encode('\r\n'),
      ])) as unknown as typeof fetch,
    });

    await expect(client.chat(request)).resolves.toMatchObject({
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 0 },
    });
  });

  it('encodes Anthropic Messages with its required limit and headers', async () => {
    const fetchImpl = vi.fn(async () => sse([
      frame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
      frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }),
      frame({ type: 'message_stop' }),
    ].join(''))) as unknown as typeof fetch;
    const client = new AnthropicMessagesClient({
      baseURL: 'https://example.test/api',
      apiKey: 'key',
      fetch: fetchImpl,
    });

    await expect(client.chat(request)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe('https://example.test/api/messages');
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(init?.headers).toEqual(expect.objectContaining({
      'x-api-key': 'key',
      'anthropic-version': '2023-06-01',
    }));
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'opaque/model:1', max_tokens: 4096, stream: true });
    expect(body.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
    });
  });

  it('encodes and decodes OpenAI Responses without an output limit or ambient auth', async () => {
    const fetchImpl = vi.fn(async () => sse(
      frame({ type: 'response.created' })
      + frame({ type: 'response.output_text.delta', delta: 'hi' })
      + frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 4, output_tokens: 2 } },
      })
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test/v1',
      fetch: fetchImpl,
    });

    await expect(client.chat(request)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hi' }],
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe('https://example.test/v1/responses');
    expect(init?.headers).not.toHaveProperty('authorization');
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.input[0].content[1]).not.toHaveProperty('dimensions');
  });

  it('decodes Chat Completions text, Tool calls, usage, and stop reason', async () => {
    const fetchImpl = vi.fn(async () => sse(
      frame({
        choices: [{
          index: 0,
          delta: {
            content: 'working',
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: { name: 'lookup', arguments: '{"id":' },
            }],
          },
          finish_reason: null,
        }],
      })
      + frame({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
          finish_reason: 'tool_calls',
        }],
      })
      + frame({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    const client = new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test/prefix',
      apiKey: 'token',
      fetch: fetchImpl,
    });

    await expect(client.chat(request)).resolves.toMatchObject({
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0])
      .toBe('https://example.test/prefix/chat/completions');
    expect(init?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer token' }));
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('maps one output-token limit to each protocol wire field', async () => {
    const responsesFetch = vi.fn(async () => sse(
      frame({ type: 'response.created' })
      + frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 0 } },
      }),
    )) as unknown as typeof fetch;
    const chatFetch = vi.fn(async () => sse(
      frame({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      + frame({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      })
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    const anthropicFetch = vi.fn(async () => sse(
      frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } })
      + frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      })
      + frame({ type: 'message_stop' }),
    )) as unknown as typeof fetch;
    const limitedRequest = { ...request, outputTokenLimit: 12_345 };

    await new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: responsesFetch,
    }).chat(limitedRequest);
    await new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: chatFetch,
    }).chat(limitedRequest);
    await new AnthropicMessagesClient({
      baseURL: 'https://example.test',
      fetch: anthropicFetch,
    }).chat(limitedRequest);

    expect(requestBody(responsesFetch)).toMatchObject({ max_output_tokens: 12_345 });
    expect(requestBody(chatFetch)).toMatchObject({ max_tokens: 12_345 });
    expect(requestBody(anthropicFetch)).toMatchObject({ max_tokens: 12_345 });
  });

  it('preserves Abort and normalizes malformed streams and HTTP failures', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async (_url, init) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        throw new Error('unexpected');
      }) as unknown as typeof fetch,
    });
    const abortEvents = await collect(aborted, { ...request, signal: controller.signal });
    const abortEvent = abortEvents.at(-1);
    expect(abortEvent?.type === 'error' ? abortEvent.error.name : undefined).toBe('AbortError');

    const malformed = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse('data: {\n\n')) as unknown as typeof fetch,
    });
    const malformedEvents = await collect(malformed, request);
    const malformedEvent = malformedEvents.at(-1);
    expect(malformedEvent?.type === 'error' ? malformedEvent.error : undefined)
      .toBeInstanceOf(ModelInvocationError);

    const overflow = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => new Response(JSON.stringify({
        error: { code: 'context_length_exceeded', message: 'secret prompt is too long' },
      }), { status: 400 })) as unknown as typeof fetch,
    });
    const overflowEvents = await collect(overflow, request);
    const overflowEvent = overflowEvents.at(-1);
    expect(overflowEvent?.type === 'error' ? overflowEvent.error : undefined)
      .toBeInstanceOf(ContextOverflowError);
  });

  it('bounds SSE events and preserves streamed provider error categories', async () => {
    const oversizedFetch = vi.fn(
      async () => sse(`data: ${'x'.repeat(1024 * 1024 + 1)}`),
    ) as unknown as typeof fetch;
    const oversized = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: oversizedFetch,
    });
    const oversizedEvents = await collect(oversized, request);
    const oversizedError = oversizedEvents.at(-1);
    expect(oversizedError?.type === 'error' ? oversizedError.error : undefined)
      .toMatchObject({ category: 'provider_failure' });

    const overloaded = new AnthropicMessagesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(frame({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Provider is overloaded.' },
      }))) as unknown as typeof fetch,
    });
    const overloadedEvents = await collect(overloaded, request);
    const overloadedError = overloadedEvents.at(-1);
    expect(overloadedError?.type === 'error' ? overloadedError.error : undefined)
      .toMatchObject({
        category: 'unavailable',
        diagnostics: {
          providerErrorType: 'overloaded_error',
          providerMessage: 'Provider is overloaded.',
        },
      });

    const overflow = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        frame({ type: 'response.created' })
        + frame({
          type: 'response.failed',
          response: {
            error: {
              code: 'context_length_exceeded',
              message: 'Maximum context length exceeded.',
            },
          },
        }),
      )) as unknown as typeof fetch,
    });
    const overflowEvents = await collect(overflow, request);
    const overflowError = overflowEvents.at(-1);
    expect(overflowError?.type === 'error' ? overflowError.error : undefined)
      .toBeInstanceOf(ContextOverflowError);
  });
});

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function crFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\r`;
}

function sse(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function chunkedSse(chunks: readonly Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(
  client: ModelInvocationPort,
  value: ModelInvocationRequest,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of client.chatStream(value)) events.push(event);
  return events;
}

function requestBody(fetchImpl: typeof fetch): Record<string, unknown> {
  const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}
