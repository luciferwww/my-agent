import { describe, expect, it, vi } from 'vitest';
import type { ModelInvocationRequest } from 'my-agent/extension-api';
import { CopilotRelayChatCompletionsClient } from './chat-client.js';

const request: ModelInvocationRequest = {
  model: 'gemini-chat',
  system: 'Be concise.',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [{
    name: 'lookup',
    description: 'Look up a value',
    inputSchema: { type: 'object' },
  }],
};

describe('Copilot Relay Chat Completions client', () => {
  it('maps effort, output limit, tools, text, usage, and auth', async () => {
    const fetchImpl = vi.fn(async () => chatResponse([
      chunk({
        model: 'gemini-response',
        choices: [{
          index: 0,
          delta: { content: 'Hello back' },
          finish_reason: 'stop',
        }],
      }),
      chunk({
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
      'data: [DONE]\n\n',
    ])) as unknown as typeof fetch;
    const client = new CopilotRelayChatCompletionsClient({
      baseURL: 'http://127.0.0.1:5000',
      apiKey: ' secret ',
      fetch: fetchImpl,
    });

    await expect(client.chat({
      ...request,
      outputTokenLimit: 2_048,
      reasoning: { effort: 'high' },
    })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Hello back' }],
      usage: { inputTokens: 7, outputTokens: 3 },
      invocation: {
        source: {
          providerId: 'copilot-relay',
          requestModelId: 'gemini-chat',
          responseModelId: 'gemini-response',
          wireProtocol: 'openai-chat-completions',
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5000/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: ['Bearer', 'secret'].join(' '),
        }),
      }),
    );
    expect(requestBody(fetchImpl)).toMatchObject({
      model: 'gemini-chat',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2_048,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object' },
        },
      }],
    });
  });

  it('captures and replays Chat reasoning and Tool calls', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse([
        chunk({
          choices: [{
            index: 0,
            delta: {
              reasoning_text: 'why',
              reasoning_opaque: 'opaque-state',
              tool_calls: [{
                index: 0,
                id: 'call-1',
                function: { name: 'lookup', arguments: '{"id":1}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        chunk({
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(chatResponse([
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
        chunk({
          choices: [],
          usage: { prompt_tokens: 6, completion_tokens: 1 },
        }),
        'data: [DONE]\n\n',
      ]));
    const client = new CopilotRelayChatCompletionsClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const first = await client.chat({
      ...request,
      invocationId: 'chat-invocation',
    });
    expect(first.content).toMatchObject([
      {
        type: 'thinking',
        id: 'chat-invocation:thinking-0',
        text: 'why',
        replay: {
          format: 'openai-chat-completions.reasoning.v1',
          payload: {
            reasoning_text: 'why',
            reasoning_opaque: 'opaque-state',
          },
        },
      },
      { type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } },
    ]);

    await client.chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: first.content,
        invocation: first.invocation,
      }],
    });
    expect(requestBody(fetchImpl as unknown as typeof fetch, 1).messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      {
        role: 'assistant',
        content: null,
        reasoning_text: 'why',
        reasoning_opaque: 'opaque-state',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1}' },
        }],
      },
    ]);
  });

  it('omits cross-protocol replay while preserving ordinary text', async () => {
    const fetchImpl = vi.fn(async () => chatResponse([
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      chunk({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      'data: [DONE]\n\n',
    ])) as unknown as typeof fetch;
    const client = new CopilotRelayChatCompletionsClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl,
    });

    await client.chat({
      ...request,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'thinking',
          id: 'responses-invocation:thinking-0',
          status: 'complete',
          text: 'summary',
          replay: {
            format: 'openai-responses.reasoning-item.v1',
            payload: {
              item: {
                type: 'reasoning',
                id: 'reasoning-1',
                summary: [],
              },
            },
          },
        }, {
          type: 'text',
          text: 'ordinary answer',
        }],
        invocation: {
          id: 'responses-invocation',
          source: {
            providerId: 'copilot-relay',
            connectionId: 'http://127.0.0.1:5000',
            requestModelId: 'responses-model',
            wireProtocol: 'openai-responses',
          },
          completion: {
            status: 'complete',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      }],
    });

    expect(requestBody(fetchImpl).messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ordinary answer' }],
      },
    ]);
  });

  it('keeps Default wire unchanged and rejects a Thinking switch before fetch', async () => {
    const successFetch = vi.fn(async () => chatResponse([
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      chunk({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      'data: [DONE]\n\n',
    ])) as unknown as typeof fetch;
    const client = new CopilotRelayChatCompletionsClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: successFetch,
    });
    await client.chat({ ...request, reasoning: { effort: 'default' } });
    expect(requestBody(successFetch)).not.toHaveProperty('reasoning_effort');

    const rejectedFetch = vi.fn() as unknown as typeof fetch;
    const rejected = new CopilotRelayChatCompletionsClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: rejectedFetch,
    });
    await expect(rejected.chat({
      ...request,
      reasoning: { thinking: 'on', effort: 'default' },
    })).rejects.toMatchObject({
      category: 'invalid_request',
      diagnostics: {
        providerMessage:
          'Copilot Relay Chat does not support the requested Thinking switch.',
      },
    });
    expect(rejectedFetch).not.toHaveBeenCalled();
  });
});

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function chatResponse(parts: readonly string[]): Response {
  return new Response(parts.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function requestBody(
  fetchImpl: typeof fetch,
  index = 0,
): Record<string, unknown> & { messages: unknown[] } {
  const init = vi.mocked(fetchImpl).mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown> & {
    messages: unknown[];
  };
}
