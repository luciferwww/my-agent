import { describe, expect, it, vi } from 'vitest';
import {
  ContextOverflowError,
  ModelInvocationError,
  type ModelInvocationPort,
  type ModelInvocationRequest,
  type ModelStreamEvent,
  type ProviderReplayState,
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

function replayState(
  format: string,
  payload: ProviderReplayState['payload'],
): ProviderReplayState {
  return { format, payload };
}

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

  it('preserves Anthropic text emitted before a Tool Call', async () => {
    const client = new AnthropicMessagesClient({
      baseURL: 'https://example.test/api',
      apiKey: 'key',
      fetch: vi.fn(async () => sse([
        frame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
        frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'still running' } }),
        frame({
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'wait-call', name: 'scope_control', input: {} },
        }),
        frame({
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"action":"wait"}' },
        }),
        frame({ type: 'content_block_stop' }),
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 4 },
        }),
        frame({ type: 'message_stop' }),
      ].join(''))) as unknown as typeof fetch,
    });

    await expect(client.chat(request)).resolves.toMatchObject({
      content: [
        { type: 'text', text: 'still running' },
        {
          type: 'tool_use',
          id: 'wait-call',
          name: 'scope_control',
          input: { action: 'wait' },
        },
      ],
      toolCalls: [{
        callId: 'wait-call',
        name: 'scope_control',
        input: { state: 'ready', value: { action: 'wait' } },
      }],
      stopReason: 'tool_use',
      usage: { inputTokens: 3, outputTokens: 4 },
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

  it('captures and replays Chat Completions reasoning inside the Client boundary', async () => {
    const captureFetch = vi.fn(async () => sse(
      frame({
        model: 'response-model',
        choices: [{
          index: 0,
          delta: { reasoning_text: 'why', reasoning_opaque: 'opaque-state' },
          finish_reason: 'stop',
        }],
      })
      + frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } })
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    const captureClient = new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: captureFetch,
    });
    const result = await captureClient.chat({ ...request, invocationId: 'invocation-1' });

    expect(result.content).toEqual([{
      type: 'thinking',
      id: 'invocation-1:thinking-0',
      status: 'complete',
      text: 'why',
      replay: {
        format: 'openai-chat-completions.reasoning.v1',
        payload: { reasoning_text: 'why', reasoning_opaque: 'opaque-state' },
      },
    }]);

    const replayFetch = vi.fn(async () => sse(
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      + frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } })
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    await new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: replayFetch,
    }).chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: result.content,
        invocation: result.invocation,
      }],
    });

    expect(requestBody(replayFetch).messages).toEqual([
      { role: 'system', content: 'system' },
      {
      role: 'assistant',
      content: null,
      reasoning_text: 'why',
      reasoning_opaque: 'opaque-state',
      },
    ]);
  });

  it('fails closed when Chat Completions sends multiple opaque reasoning values', async () => {
    const client = new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        frame({
          choices: [{
            index: 0,
            delta: { reasoning_opaque: 'first' },
            finish_reason: null,
          }],
        })
        + frame({
          choices: [{
            index: 0,
            delta: { reasoning_opaque: 'second' },
            finish_reason: 'stop',
          }],
        }),
      )) as unknown as typeof fetch,
    });

    await expect(client.chat({ ...request, invocationId: 'invocation-1' }))
      .rejects.toMatchObject({
        name: 'ModelInvocationError',
        category: 'provider_failure',
      });
  });

  it('closes interrupted Chat reasoning as readable partial state without opaque replay', async () => {
    const client = new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(frame({
        choices: [{
          index: 0,
          delta: {
            reasoning_text: 'partial thought',
            reasoning_opaque: 'incomplete opaque state',
          },
          finish_reason: null,
        }],
      }))) as unknown as typeof fetch,
    });

    const events = await collect(client, { ...request, invocationId: 'invocation-1' });
    expect(events).toContainEqual({
      type: 'thinking_end',
      blockId: 'thinking-0',
      completion: { status: 'partial', text: 'partial thought' },
    });
    expect(JSON.stringify(events)).not.toContain('incomplete opaque state');
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('captures and replays complete Responses reasoning items inside the Client boundary', async () => {
    const item = {
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [
        { type: 'summary_text', text: 'first' },
        { type: 'summary_text', text: 'second' },
      ],
      content: [{ type: 'reasoning_text', text: 'private detail' }],
      encrypted_content: 'encrypted-state',
      status: 'completed',
    };
    const captureFetch = vi.fn(async () => sse(
      frame({ type: 'response.created', response: { model: 'response-model' } })
      + frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      })
      + frame({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'reasoning-1',
        summary_index: 0,
        delta: 'first',
      })
      + frame({ type: 'response.output_item.done', item })
      + frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 4, output_tokens: 2 } },
      }),
    )) as unknown as typeof fetch;
    const result = await new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: captureFetch,
    }).chat({ ...request, invocationId: 'invocation-1' });

    expect(result.content).toEqual([{
      type: 'thinking',
      id: 'invocation-1:thinking-0',
      status: 'complete',
      text: 'first\n\nsecond',
      replay: {
        format: 'openai-responses.reasoning-item.v1',
        payload: { item },
      },
    }]);

    const replayFetch = vi.fn(async () => sse(
      frame({ type: 'response.created' })
      + frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 0 } },
      }),
    )) as unknown as typeof fetch;
    await new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: replayFetch,
    }).chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: result.content,
        invocation: result.invocation,
      }],
    });

    expect(requestBody(replayFetch).input).toEqual([item]);
  });

  it('accepts opaque-only Responses reasoning before a text answer', async () => {
    const item = {
      type: 'reasoning',
      id: 'reasoning-opaque',
      summary: [],
      content: [],
      encrypted_content: 'encrypted-state',
    };
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        frame({ type: 'response.created', response: { model: 'response-model' } })
        + frame({ type: 'response.in_progress', response: { status: 'in_progress' } })
        + frame({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'reasoning-added',
            summary: [],
            content: [],
            encrypted_content: 'encrypted-state',
          },
        })
        + frame({ type: 'response.output_item.done', output_index: 0, item })
        + frame({
          type: 'response.output_item.added',
          output_index: 1,
          item: {
            type: 'message',
            id: 'message-1',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        })
        + frame({ type: 'response.output_text.delta', delta: 'answer' })
        + frame({
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'message',
            id: 'message-1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'answer' }],
          },
        })
        + frame({
          type: 'response.completed',
          response: { usage: { input_tokens: 4, output_tokens: 2 } },
        }),
      )) as unknown as typeof fetch,
    });

    await expect(client.chat({ ...request, invocationId: 'invocation-1' })).resolves.toMatchObject({
      content: [{
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'complete',
        text: '',
        replay: {
          format: 'openai-responses.reasoning-item.v1',
          payload: { item },
        },
      }, {
        type: 'text',
        text: 'answer',
      }],
      stopReason: 'end_turn',
    });
  });

  it('correlates Responses summary deltas by output_index when item ids change', async () => {
    const item = {
      type: 'reasoning',
      id: 'reasoning-done',
      summary: [{ type: 'summary_text', text: 'visible summary' }],
      encrypted_content: 'encrypted-state',
    };
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        frame({ type: 'response.created' })
        + frame({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-added' },
        })
        + frame({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning-delta',
          output_index: 0,
          summary_index: 0,
          delta: 'visible summary',
        })
        + frame({
          type: 'response.output_item.done',
          output_index: 0,
          item,
        })
        + frame({
          type: 'response.completed',
          response: { usage: { input_tokens: 4, output_tokens: 2 } },
        }),
      )) as unknown as typeof fetch,
    });

    await expect(client.chat({ ...request, invocationId: 'invocation-1' })).resolves.toMatchObject({
      content: [{
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'complete',
        text: 'visible summary',
        replay: {
          format: 'openai-responses.reasoning-item.v1',
          payload: { item },
        },
      }],
    });
  });

  it('does not expose an uncorrelated Responses reasoning id in diagnostics', async () => {
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        frame({ type: 'response.created' })
        + frame({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-added' },
        })
        + frame({
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'private-opaque-id',
            summary: [],
            encrypted_content: 'encrypted-state',
          },
        }),
      )) as unknown as typeof fetch,
    });

    const error = await client.chat({ ...request, invocationId: 'invocation-1' })
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({
      category: 'provider_failure',
      diagnostics: {
        providerMessage: 'OpenAI Responses completed an unknown reasoning item.',
      },
    });
    expect(JSON.stringify(error)).not.toContain('private-opaque-id');
  });

  it('keeps incomplete Responses reasoning as display-only partial state', async () => {
    const client = new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: vi.fn(async () => sse(
        frame({ type: 'response.created' })
        + frame({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-1' },
        })
        + frame({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning-1',
          summary_index: 0,
          delta: 'partial summary',
        })
        + frame({
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: [{ type: 'summary_text', text: 'partial summary' }],
            encrypted_content: 'incomplete state',
            status: 'incomplete',
          },
        })
        + frame({
          type: 'response.completed',
          response: { usage: { input_tokens: 4, output_tokens: 2 } },
        }),
      )) as unknown as typeof fetch,
    });

    const result = await client.chat({ ...request, invocationId: 'invocation-1' });
    expect(result).toMatchObject({
      content: [{
        type: 'thinking',
        id: 'invocation-1:thinking-0',
        status: 'partial',
        text: 'partial summary',
      }],
    });
    expect(JSON.stringify(result)).not.toContain('incomplete state');
  });

  it.each([
    {
      label: 'Chat Completions',
      create: (fetchImpl: typeof fetch) => new OpenAIChatCompletionsClient({
        baseURL: 'https://example.test',
        fetch: fetchImpl,
      }),
      wireProtocol: 'openai-chat-completions' as const,
      replay: replayState(
        'openai-chat-completions.reasoning.v1',
        { reasoning_opaque: 'opaque-state' },
      ),
    },
    {
      label: 'Responses',
      create: (fetchImpl: typeof fetch) => new OpenAIResponsesClient({
        baseURL: 'https://example.test',
        fetch: fetchImpl,
      }),
      wireProtocol: 'openai-responses' as const,
      replay: replayState(
        'openai-responses.reasoning-item.v1',
        {
          item: {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: [],
            encrypted_content: 'encrypted-state',
          },
        },
      ),
    },
  ])('rejects incompatible $label replay before sending a request', async ({
    create,
    wireProtocol,
    replay,
  }) => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch must not be called');
    }) as unknown as typeof fetch;
    const client = create(fetchImpl);

    await expect(client.chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'thinking',
          id: 'invocation-1:thinking-0',
          status: 'complete',
          text: '',
          replay,
        }],
        invocation: {
          id: 'invocation-1',
          source: {
            providerId: 'builtin',
            connectionId: 'https://different.example.test',
            requestModelId: request.model,
            wireProtocol,
          },
          completion: {
            status: 'complete',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      }],
    })).rejects.toMatchObject({
      name: 'ModelInvocationError',
      category: 'provider_failure',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits cross-protocol Thinking while preserving ordinary assistant text', async () => {
    const chatFetch = vi.fn(async () => sse(
      frame({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      + frame({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      }),
    )) as unknown as typeof fetch;
    const responsesFetch = vi.fn(async () => sse(
      frame({ type: 'response.created' })
      + frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 0 } },
      }),
    )) as unknown as typeof fetch;
    const anthropicFetch = vi.fn(async () => sse(
      frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } })
      + frame({ type: 'message_stop' }),
    )) as unknown as typeof fetch;
    const completion = {
      status: 'complete' as const,
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };

    await new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: chatFetch,
    }).chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'thinking',
          id: 'responses-invocation:thinking-0',
          status: 'complete',
          text: 'responses summary',
          replay: replayState(
            'openai-responses.reasoning-item.v1',
            {
              item: {
                type: 'reasoning',
                id: 'reasoning-1',
                summary: [{ type: 'summary_text', text: 'responses summary' }],
                encrypted_content: 'encrypted-state',
              },
            },
          ),
        }, {
          type: 'text',
          text: 'ordinary answer',
        }],
        invocation: {
          id: 'responses-invocation',
          source: {
            providerId: 'builtin',
            connectionId: 'https://example.test',
            requestModelId: 'responses-model',
            wireProtocol: 'openai-responses',
          },
          completion,
        },
      }],
    });

    expect(requestBody(chatFetch).messages).toEqual([
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ordinary answer' }],
      },
    ]);

    await new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: responsesFetch,
    }).chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'thinking',
          id: 'chat-invocation:thinking-0',
          status: 'complete',
          text: 'chat reasoning',
          replay: replayState(
            'openai-chat-completions.reasoning.v1',
            { reasoning_text: 'chat reasoning', reasoning_opaque: 'opaque-state' },
          ),
        }, {
          type: 'text',
          text: 'ordinary answer',
        }],
        invocation: {
          id: 'chat-invocation',
          source: {
            providerId: 'builtin',
            connectionId: 'https://example.test',
            requestModelId: 'chat-model',
            wireProtocol: 'openai-chat-completions',
          },
          completion,
        },
      }],
    });

    expect(requestBody(responsesFetch).input).toEqual([{
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ordinary answer' }],
    }]);

    await new AnthropicMessagesClient({
      baseURL: 'https://example.test',
      fetch: anthropicFetch,
    }).chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'thinking',
          id: 'responses-invocation:thinking-0',
          status: 'complete',
          text: 'responses summary',
          replay: replayState(
            'openai-responses.reasoning-item.v1',
            {
              item: {
                type: 'reasoning',
                id: 'reasoning-1',
                summary: [{ type: 'summary_text', text: 'responses summary' }],
                encrypted_content: 'encrypted-state',
              },
            },
          ),
        }, {
          type: 'text',
          text: 'ordinary answer',
        }],
        invocation: {
          id: 'responses-invocation',
          source: {
            providerId: 'builtin',
            connectionId: 'https://example.test',
            requestModelId: 'responses-model',
            wireProtocol: 'openai-responses',
          },
          completion,
        },
      }],
    });

    expect(requestBody(anthropicFetch).messages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'ordinary answer' }],
    }]);
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

  it('projects accepted receipts and trusted Host messages for all protocols', async () => {
    const lifecycleRequest: ModelInvocationRequest = {
      model: 'test',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'demo', input: { value: 1 } }],
        },
        {
          role: 'user',
          content: [{
            type: 'execution_accepted',
            tool_use_id: 'call-1',
            execution_id: 'execution-1',
          }],
        },
        {
          role: 'user',
          origin: 'host',
          content: 'trusted Host completion envelope',
        },
      ],
    };
    const anthropicFetch = vi.fn(async () => sse(
      frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } })
      + frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      })
      + frame({ type: 'message_stop' }),
    )) as unknown as typeof fetch;
    const chatFetch = vi.fn(async () => sse(
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      + frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } })
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    const responsesFetch = vi.fn(async () => sse(
      frame({ type: 'response.created' })
      + frame({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 0 } },
      }),
    )) as unknown as typeof fetch;

    await collect(new AnthropicMessagesClient({
      baseURL: 'https://example.test',
      apiKey: 'token',
      fetch: anthropicFetch,
    }), lifecycleRequest);
    await collect(new OpenAIChatCompletionsClient({
      baseURL: 'https://example.test',
      fetch: chatFetch,
    }), lifecycleRequest);
    await collect(new OpenAIResponsesClient({
      baseURL: 'https://example.test',
      fetch: responsesFetch,
    }), lifecycleRequest);

    const accepted = '{"status":"accepted","executionId":"execution-1"}';
    expect(requestBody(anthropicFetch).messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'demo', input: { value: 1 } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: accepted }],
      },
      { role: 'user', content: 'trusted Host completion envelope' },
    ]);
    expect(requestBody(chatFetch).messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'demo', arguments: '{"value":1}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: accepted },
      { role: 'user', content: 'trusted Host completion envelope' },
    ]);
    expect(requestBody(responsesFetch).input).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'demo', arguments: '{"value":1}' },
      { type: 'function_call_output', call_id: 'call-1', output: accepted },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'trusted Host completion envelope' }],
      },
    ]);
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
      .toMatchObject({
        category: 'provider_failure',
        diagnostics: {
          providerMessage: 'OpenAI Responses sent malformed SSE JSON.',
        },
      });

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
