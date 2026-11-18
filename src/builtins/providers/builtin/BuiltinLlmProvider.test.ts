import { describe, expect, it, vi } from 'vitest';
import { providerPort } from '../../../test-fixtures/provider.js';
import type {
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import {
  BUILTIN_MODEL_ROUTER_PROTOCOL,
  BuiltinLlmProvider,
} from './BuiltinLlmProvider.js';
import type { BuiltinProtocol } from './config.js';

const request: ModelInvocationRequest = {
  model: 'alpha',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('BuiltinLlmProvider', () => {
  it('routes captured per-model paths across protocols and same-protocol concurrent calls', async () => {
    const first = { modelId: 'responses', protocol: 'openai-responses' as const, endpoint: 'responses' };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      const events = body.model === 'messages'
        ? [
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ]
        : body.model === 'chat'
          ? [
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
              { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
            ]
          : [
              { type: 'response.created' },
              { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test/api',
      models: [
        first,
        { modelId: 'versioned', protocol: 'openai-responses', endpoint: 'v1/responses' },
        { modelId: 'chat', protocol: 'openai-chat-completions', endpoint: 'openai/v1/chat/completions' },
        { modelId: 'messages', protocol: 'anthropic-messages', endpoint: 'anthropic/v1/messages' },
        { modelId: 'legacy', protocol: 'openai-responses' },
      ],
    }, { fetch: fetchImpl });
    first.endpoint = 'must-not-replace-the-captured-path';

    await Promise.all(['responses', 'versioned', 'chat', 'messages', 'legacy'].map((model) =>
      providerPort(provider.entry).chat({ model, messages: [], sessionId: model })));

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://example.test/api/responses',
      'https://example.test/api/v1/responses',
      'https://example.test/api/openai/v1/chat/completions',
      'https://example.test/api/anthropic/v1/messages',
      'https://example.test/api/responses',
    ]);
    expect(fetchImpl.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get('x-opencode-session')))
      .toEqual(['responses', 'versioned', 'chat', 'messages', 'legacy']);
  });

  it('publishes one immutable Provider entry and routes exact model IDs', async () => {
    const calls: string[] = [];
    const created: BuiltinProtocol[] = [];
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test/v1',
      models: [
        {
          modelId: 'alpha',
          protocol: 'openai-responses',
          displayName: 'Alpha',
          maximumContextTokens: 300_000,
          maximumPromptTokens: 272_000,
          maximumOutputTokens: 28_000,
          outputTokenLimit: 16_000,
        },
        { modelId: 'beta', protocol: 'anthropic-messages' },
      ],
    }, {
      createClient(protocol) {
        created.push(protocol);
        return client(protocol, calls);
      },
    });

    expect(provider.entry).toMatchObject({
      id: 'builtin',
      displayName: 'Built-in LLM',
      protocol: BUILTIN_MODEL_ROUTER_PROTOCOL,
    });
    expect((await provider.entry.getModelCatalog()).models).toEqual([
      { modelId: 'alpha', displayName: 'Alpha' }, { modelId: 'beta' },
    ]);
    expect(Object.isFrozen(provider.entry)).toBe(true);
    expect(Object.isFrozen((await provider.entry.getModelCatalog()).models)).toBe(true);
    expect(created).toEqual(['openai-responses', 'anthropic-messages']);
    await providerPort(provider.entry).chat(request);
    await providerPort(provider.entry).chat({ ...request, model: 'beta' });
    expect(calls).toEqual(['openai-responses:alpha', 'anthropic-messages:beta']);
    await expect(providerPort(provider.entry).chat({ ...request, model: 'Alpha' }))
      .rejects.toThrow('outside its Catalog');

    const connection = provider.entry.resolveConnection();
    expect(connection).toEqual({
      ok: true,
      connection: { endpointId: 'https://example.test/v1' },
    });
    if (!connection.ok) throw new Error('Expected connection.');
    expect((await provider.entry.getModelCatalog()).resolveModel('alpha', connection.connection)).toMatchObject({
      ok: true,
      descriptor: {
        identity: { providerId: 'builtin', modelId: 'alpha' },
        protocol: 'builtin-model-router',
        connection: { endpointId: 'https://example.test/v1' },
        facts: {
          effectiveContextLimit: 272_000,
          maximumContextTokens: 300_000,
          maximumPromptTokens: 272_000,
          maximumOutputTokens: 28_000,
        },
        invocationDefaults: { outputTokenLimit: 16_000 },
      },
    });
    expect((await provider.entry.getModelCatalog()).resolveModel('beta', connection.connection)).toMatchObject({
      ok: true,
      descriptor: {
        identity: { providerId: 'builtin', modelId: 'beta' },
        protocol: 'builtin-model-router',
        connection: { endpointId: 'https://example.test/v1' },
        facts: { effectiveContextLimit: 131_072 },
      },
    });
    expect((await provider.entry.getModelCatalog()).resolveModel('missing', connection.connection)).toMatchObject({
      ok: false,
      category: 'model_rejected',
    });
  });

  it('creates no Clients for an empty model list', async () => {
    const createClient = vi.fn();
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test/v1',
      models: [],
    }, { createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect((await provider.entry.getModelCatalog()).models).toEqual([]);
  });

  it('creates one Client per referenced Protocol', () => {
    const createClient = vi.fn((protocol: BuiltinProtocol) => client(protocol, []));
    new BuiltinLlmProvider({
      baseURL: 'https://example.test',
      models: [
        { modelId: 'one', protocol: 'openai-responses' },
        { modelId: 'two', protocol: 'openai-responses' },
      ],
    }, { createClient });
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('projects one captured empty reasoning capability snapshot to Catalog and Facts', async () => {
    const thinking: Array<'on' | 'off'> = [];
    const efforts: Array<'high' | 'low'> = [];
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test',
      models: [{
        modelId: 'one',
        protocol: 'openai-responses',
        reasoning: { thinking, efforts },
      }],
    }, {
      createClient: (protocol) => client(protocol, []),
    });

    thinking.push('on');
    efforts.push('high');

    const catalogReasoning = (await provider.entry.getModelCatalog()).models[0]?.capabilities?.reasoning;
    expect(catalogReasoning).toEqual({
      thinking: [],
      efforts: [],
    });
    expect(Object.isFrozen(catalogReasoning)).toBe(true);
    expect(Object.isFrozen(catalogReasoning?.thinking)).toBe(true);
    expect(Object.isFrozen(catalogReasoning?.efforts)).toBe(true);

    const connection = provider.entry.resolveConnection();
    if (!connection.ok) throw new Error('Expected connection.');
    const model = (await provider.entry.getModelCatalog()).resolveModel('one', connection.connection);
    if (!model.ok) throw new Error('Expected model.');
    expect(model.descriptor.facts.reasoning).toBe(catalogReasoning);
  });

  it('publishes non-empty reasoning capabilities after Client mapping is available', async () => {
    const requests: ModelInvocationRequest[] = [];
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test',
      models: [{
        modelId: 'one',
        protocol: 'openai-responses',
        reasoning: { efforts: ['high'] },
      }],
    }, {
      createClient: () => ({
        async *chatStream(value) {
          requests.push(value);
          yield { type: 'message_start' };
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
        async chat(value) {
          requests.push(value);
          return {
            content: [],
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      }),
    });

    expect((await provider.entry.getModelCatalog()).models[0]?.capabilities?.reasoning)
      .toEqual({ efforts: ['high'] });
    await providerPort(provider.entry).chat({
      ...request,
      model: 'one',
      reasoning: { effort: 'high' },
    });
    expect(requests[0]?.reasoning).toEqual({ effort: 'high' });
  });

  it('requests a Responses summary only when Thinking is on', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      [
        `data: ${JSON.stringify({ type: 'response.created' })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: { usage: { input_tokens: 1, output_tokens: 1 } },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test',
      models: [
        {
          modelId: 'responses',
          protocol: 'openai-responses',
          reasoning: { thinking: ['on', 'off'], efforts: ['high'] },
        },
      ],
    }, { fetch: fetchImpl });

    await providerPort(provider.entry).chat({
      model: 'responses',
      messages: [],
      reasoning: { thinking: 'on', effort: 'high' },
    });
    await providerPort(provider.entry).chat({
      model: 'responses',
      messages: [],
      reasoning: { effort: 'high' },
    });

    const bodies = vi.mocked(fetchImpl).mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: 'high', summary: 'detailed' },
      { effort: 'high' },
    ]);
  });

  it('wires configured Thinking switches into both OpenAI protocol Clients', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const data = url.endsWith('/responses')
        ? [
            'data: {"type":"response.created"}\n\n',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            'data: [DONE]\n\n',
          ]
        : [
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
            'data: [DONE]\n\n',
          ];
      return new Response(data.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test',
      models: [
        {
          modelId: 'responses',
          protocol: 'openai-responses',
          reasoning: { thinking: ['on', 'off'] },
        },
        {
          modelId: 'chat',
          protocol: 'openai-chat-completions',
          reasoning: { thinking: ['on', 'off'] },
        },
      ],
    }, { fetch: fetchImpl });

    await providerPort(provider.entry).chat({
      ...request,
      model: 'responses',
      reasoning: { thinking: 'off', effort: 'default' },
    });
    await providerPort(provider.entry).chat({
      ...request,
      model: 'chat',
      reasoning: { thinking: 'off', effort: 'default' },
    });

    const bodies = vi.mocked(fetchImpl).mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]?.reasoning).toEqual({ effort: 'none' });
    expect(bodies[1]?.reasoning_effort).toBe('none');
  });

  it('applies model output defaults and clamps explicit overrides to capability', async () => {
    const requests: ModelInvocationRequest[] = [];
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test',
      models: [{
        modelId: 'one',
        protocol: 'openai-responses',
        maximumOutputTokens: 8_192,
        outputTokenLimit: 16_384,
      }],
    }, {
      createClient: () => ({
        async *chatStream(value) {
          requests.push(value);
          yield { type: 'message_start' };
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
        async chat(value) {
          requests.push(value);
          return {
            content: [],
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      }),
    });

    await providerPort(provider.entry).chat({
      model: 'one',
      messages: [],
    });
    await providerPort(provider.entry).chat({
      model: 'one',
      messages: [],
      outputTokenLimit: 32_768,
    });

    expect(requests.map((value) => value.outputTokenLimit)).toEqual([8_192, 8_192]);
  });
});

function client(protocol: BuiltinProtocol, calls: string[]): ModelInvocationPort {
  const response: ModelInvocationResponse = {
    content: [],
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  return {
    chat(value) {
      calls.push(`${protocol}:${value.model}`);
      return Promise.resolve(response);
    },
    async *chatStream(): AsyncIterable<ModelStreamEvent> {
      yield { type: 'message_start' };
      yield { type: 'message_end', stopReason: 'end_turn', usage: response.usage };
    },
  };
}
