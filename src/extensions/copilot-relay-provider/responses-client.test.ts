import { describe, expect, it, vi } from 'vitest';
import { ModelInvocationError, type ModelInvocationRequest } from '../../core/model-invocation/index.js';
import { CopilotRelayResponsesClient } from './responses-client.js';

const request: ModelInvocationRequest = {
  model: 'gpt-5.6-sol',
  system: 'Be concise.',
  maxTokens: 128,
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
  ],
  tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object' } }],
};

function event(type: string, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ type, ...extra })}\n\n`;
}

function terminal(
  type = 'response.completed',
  extra: Record<string, unknown> = {},
): string {
  return event(type, {
    response: {
      usage: { input_tokens: 7, output_tokens: 3 },
      ...extra,
    },
  });
}

function sseResponse(source: string | Uint8Array[]): Response {
  const chunks = typeof source === 'string'
    ? [new TextEncoder().encode(source)]
    : source;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(client: CopilotRelayResponsesClient, value = request) {
  const events = [];
  for await (const entry of client.chatStream(value)) events.push(entry);
  return events;
}

describe('Copilot Relay Responses client', () => {
  it('maps request history, tools, text deltas, usage, and one terminal', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(
      event('response.created')
      + event('response.output_text.delta', { delta: 'Hello back' })
      + terminal()
      + 'data: [DONE]\n\n',
    )) as unknown as typeof fetch;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      apiKey: ' secret ',
      fetch: fetchImpl,
    });

    await expect(collect(client)).resolves.toEqual([
      { type: 'message_start' },
      { type: 'text_delta', text: 'Hello back' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(init?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer secret' }));
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-sol',
      max_output_tokens: 128,
      stream: true,
      instructions: 'Be concise.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
      ],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    });
    expect(body).not.toHaveProperty('previous_response_id');
  });

  it('uses complete function_call items and call_id for stateless tool replay', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(
      event('response.created')
      + event('response.function_call_arguments.delta', {
        item_id: 'unstable-delta-1',
        delta: '{"key":',
      })
      + event('response.function_call_arguments.delta', {
        item_id: 'unstable-delta-2',
        delta: '"value"}',
      })
      + event('response.output_item.done', {
        item: {
          type: 'function_call',
          id: 'unstable-item-id',
          call_id: 'call-1',
          name: 'lookup',
          arguments: '{"key":"value"}',
        },
      })
      + terminal(),
    )) as unknown as typeof fetch;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl,
    });
    const toolRequest: ModelInvocationRequest = {
      ...request,
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { key: 'value' } }],
      }, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'found' }],
      }],
    };

    await expect(collect(client, toolRequest)).resolves.toEqual([
      { type: 'message_start' },
      {
        type: 'tool_call',
        call: {
          callId: 'call-1',
          name: 'lookup',
          input: { state: 'ready', value: { key: 'value' } },
        },
      },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body));
    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"key":"value"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'found' },
    ]);
    expect(JSON.stringify(body)).not.toContain('unstable-item-id');
    expect(JSON.stringify(body)).not.toContain('unstable-delta');
  });

  it('maps images and max-output incomplete terminals', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(
      event('response.created')
      + terminal('response.incomplete', {
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    )) as unknown as typeof fetch;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl,
    });
    const imageRequest: ModelInvocationRequest = {
      ...request,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
          dimensions: { width: 2, height: 2 },
        }],
      }],
    };

    const events = await collect(client, imageRequest);
    expect(events.at(-1)).toEqual({
      type: 'message_end',
      stopReason: 'max_tokens',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body));
    expect(body.input[0].content).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,cG5n' },
    ]);
    expect(body.input[0].content[0]).not.toHaveProperty('dimensions');
  });

  it('preserves malformed Tool arguments as canonical invalid input', async () => {
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => sseResponse(
        event('response.created')
        + event('response.output_item.done', {
          item: { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{' },
        })
        + terminal(),
      )) as unknown as typeof fetch,
    });
    expect(await collect(client)).toContainEqual({
      type: 'tool_call',
      call: {
        callId: 'call-1',
        name: 'lookup',
        input: { state: 'invalid', reason: 'malformed_json' },
      },
    });
  });

  it.each([
    ['malformed frame', event('response.created') + 'data: {\n\n'],
    ['terminal before created', terminal()],
    ['early close', event('response.created')],
    ['DONE before terminal', event('response.created') + 'data: [DONE]\n\n'],
    ['duplicate DONE', event('response.created') + terminal() + 'data: [DONE]\n\ndata: [DONE]\n\n'],
    ['duplicate terminal', event('response.created') + terminal() + terminal()],
    ['event after terminal', event('response.created') + terminal() + event('response.in_progress')],
    ['unknown terminal', event('response.created') + event('response.cancelled') + terminal()],
    ['arbitrary unknown response state', event('response.created') + event('response.suspended') + terminal()],
    ['Tool output before created', event('response.output_item.done', {
      item: { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
    }) + event('response.created') + terminal()],
    ['Tool item start before created', event('response.output_item.added', {
      item: { type: 'function_call', call_id: 'call-1', name: 'lookup' },
    }) + event('response.created') + terminal()],
    ['Tool arguments before created', event('response.function_call_arguments.delta', {
      item_id: 'unstable', delta: '{}',
    }) + event('response.created') + terminal()],
    ['response failed', event('response.created') + event('response.failed')],
    ['SSE error', event('response.created') + event('error')],
  ])('fails closed for %s', async (_label, source) => {
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => sseResponse(source)) as unknown as typeof fetch,
    });
    const events = await collect(client);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { name: 'ModelInvocationError', category: 'provider_failure' },
    });
    expect(events.some((entry) => entry.type === 'message_end')).toBe(false);
  });

  it('decodes partial UTF-8 boundaries', async () => {
    const source = event('response.created')
      + event('response.output_text.delta', { delta: '你好' })
      + terminal();
    const encoded = new TextEncoder().encode(source);
    const split = encoded.findIndex((value) => value >= 0x80) + 1;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => sseResponse([
        encoded.slice(0, split),
        encoded.slice(split),
      ])) as unknown as typeof fetch,
    });
    expect(await collect(client)).toContainEqual({ type: 'text_delta', text: '你好' });
  });

  it('keeps AbortError and emits no successful terminal after partial content', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input, init) => new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(
            event('response.created') + event('response.output_text.delta', { delta: 'partial' }),
          ));
          init?.signal?.addEventListener('abort', () => {
            stream.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl,
    });
    const events = [];
    for await (const entry of client.chatStream({ ...request, signal: controller.signal })) {
      events.push(entry);
      if (entry.type === 'text_delta') controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { name: 'AbortError' } });
    expect(events.some((entry) => entry.type === 'message_end')).toBe(false);
  });

  it('settles AbortError while a response body read is pending', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {},
    }))) as unknown as typeof fetch;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl,
    });
    const collecting = collect(client, { ...request, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    const events = await collecting;
    expect(events).toEqual([{
      type: 'error',
      error: expect.objectContaining({ name: 'AbortError' }),
    }]);
  });

  it('settles AbortError while an HTTP error body read is pending', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {},
    }), { status: 400 })) as unknown as typeof fetch;
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: fetchImpl,
    });
    const collecting = collect(client, { ...request, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    expect(await collecting).toEqual([{
      type: 'error',
      error: expect.objectContaining({ name: 'AbortError' }),
    }]);
  });

  it.each([
    ['missing', { input_tokens: 1 }],
    ['negative', { input_tokens: -1, output_tokens: 1 }],
    ['fractional', { input_tokens: 1, output_tokens: 1.5 }],
    ['oversized', { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ])('fails closed for %s terminal usage', async (_label, usage) => {
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => sseResponse(
        event('response.created')
        + event('response.completed', { response: { usage } }),
      )) as unknown as typeof fetch,
    });
    expect((await collect(client)).at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'provider_failure' },
    });
  });

  it.each([
    ['non-object arguments', [
      { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '[]' },
    ]],
    ['duplicate call_id', [
      { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
      { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
    ]],
    ['blank call_id', [
      { type: 'function_call', call_id: ' ', name: 'lookup', arguments: '{}' },
    ]],
    ['blank name', [
      { type: 'function_call', call_id: 'call-1', name: ' ', arguments: '{}' },
    ]],
  ])('handles invalid Tool case: %s', async (label, items) => {
    const source = event('response.created')
      + items.map((item) => event('response.output_item.done', { item })).join('')
      + terminal();
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => sseResponse(source)) as unknown as typeof fetch,
    });
    const events = await collect(client);
    if (label === 'non-object arguments') {
      expect(events).toContainEqual({
        type: 'tool_call',
        call: {
          callId: 'call-1',
          name: 'lookup',
          input: { state: 'invalid', reason: 'not_an_object' },
        },
      });
    } else {
      expect(events.at(-1)).toMatchObject({ type: 'error' });
      expect(events.some((entry) => entry.type === 'message_end')).toBe(false);
    }
  });

  it('assembles chat content and complete Tool Calls from the stream', async () => {
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => sseResponse(
        event('response.created')
        + event('response.output_text.delta', { delta: 'before' })
        + event('response.output_item.done', {
          item: { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
        })
        + event('response.output_text.delta', { delta: 'after' })
        + terminal(),
      )) as unknown as typeof fetch,
    });
    await expect(client.chat(request)).resolves.toMatchObject({
      content: [
        { type: 'text', text: 'before' },
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
        { type: 'text', text: 'after' },
      ],
      toolCalls: [{ callId: 'call-1', name: 'lookup', input: { state: 'ready', value: {} } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it('normalizes bounded HTTP errors without retaining request content', async () => {
    const client = new CopilotRelayResponsesClient({
      baseURL: 'http://127.0.0.1:5000',
      fetch: vi.fn(async () => Response.json({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_model',
          message: 'Invalid model.\nRetry.',
        },
      }, {
        status: 400,
        headers: { 'x-request-id': 'request-1' },
      })) as unknown as typeof fetch,
    });
    const events = await collect(client);
    const last = events.at(-1);
    expect(last).toMatchObject({
      type: 'error',
      error: {
        name: 'ModelInvocationError',
        category: 'invalid_request',
        diagnostics: {
          providerId: 'copilot-relay',
          httpStatus: 400,
          providerErrorType: 'invalid_request_error',
          providerErrorCode: 'invalid_model',
          providerMessage: 'Invalid model. Retry.',
          requestId: 'request-1',
        },
      },
    });
    if (last?.type !== 'error' || !(last.error instanceof ModelInvocationError)) {
      throw new Error('Expected ModelInvocationError.');
    }
    expect(JSON.stringify(last.error.diagnostics)).not.toContain('Be concise.');
  });
});
