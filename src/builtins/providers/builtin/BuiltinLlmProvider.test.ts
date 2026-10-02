import { describe, expect, it, vi } from 'vitest';
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
      models: [{ modelId: 'alpha', displayName: 'Alpha' }, { modelId: 'beta' }],
    });
    expect(Object.isFrozen(provider.entry)).toBe(true);
    expect(Object.isFrozen(provider.entry.models)).toBe(true);
    expect(created).toEqual(['openai-responses', 'anthropic-messages']);
    await provider.entry.invocationPort.chat(request);
    await provider.entry.invocationPort.chat({ ...request, model: 'beta' });
    expect(calls).toEqual(['openai-responses:alpha', 'anthropic-messages:beta']);
    await expect(provider.entry.invocationPort.chat({ ...request, model: 'Alpha' }))
      .rejects.toThrow('no registration');

    const connection = provider.entry.resolveConnection();
    expect(connection).toEqual({
      ok: true,
      connection: { endpointId: 'https://example.test/v1' },
    });
    if (!connection.ok) throw new Error('Expected connection.');
    expect(provider.entry.resolveModel('alpha', connection.connection)).toEqual({
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
    expect(provider.entry.resolveModel('beta', connection.connection)).toEqual({
      ok: true,
      descriptor: {
        identity: { providerId: 'builtin', modelId: 'beta' },
        protocol: 'builtin-model-router',
        connection: { endpointId: 'https://example.test/v1' },
        facts: { effectiveContextLimit: 32_768 },
      },
    });
    expect(provider.entry.resolveModel('missing', connection.connection)).toMatchObject({
      ok: false,
      category: 'model_rejected',
    });
  });

  it('creates no Clients for an empty model list', () => {
    const createClient = vi.fn();
    const provider = new BuiltinLlmProvider({
      baseURL: 'https://example.test/v1',
      models: [],
    }, { createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(provider.entry.models).toEqual([]);
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

  it('projects one captured empty reasoning capability snapshot to Catalog and Facts', () => {
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

    const catalogReasoning = provider.entry.models[0]?.capabilities?.reasoning;
    expect(catalogReasoning).toEqual({
      thinking: [],
      efforts: [],
    });
    expect(Object.isFrozen(catalogReasoning)).toBe(true);
    expect(Object.isFrozen(catalogReasoning?.thinking)).toBe(true);
    expect(Object.isFrozen(catalogReasoning?.efforts)).toBe(true);

    const connection = provider.entry.resolveConnection();
    if (!connection.ok) throw new Error('Expected connection.');
    const model = provider.entry.resolveModel('one', connection.connection);
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

    expect(provider.entry.models[0]?.capabilities?.reasoning)
      .toEqual({ efforts: ['high'] });
    await provider.entry.invocationPort.chat({
      ...request,
      model: 'one',
      reasoning: { effort: 'high' },
    });
    expect(requests[0]?.reasoning).toEqual({ effort: 'high' });
  });

  it('keeps private Responses summary behavior scoped to its configured model', async () => {
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
          modelId: 'summary',
          protocol: 'openai-responses',
          reasoning: { efforts: ['high'] },
          readableSummary: 'auto-on-explicit-reasoning',
        },
        {
          modelId: 'plain',
          protocol: 'openai-responses',
          reasoning: { efforts: ['high'] },
        },
      ],
    }, { fetch: fetchImpl });

    await provider.entry.invocationPort.chat({
      model: 'summary',
      messages: [],
      reasoning: { effort: 'high' },
    });
    await provider.entry.invocationPort.chat({
      model: 'plain',
      messages: [],
      reasoning: { effort: 'high' },
    });

    const bodies = vi.mocked(fetchImpl).mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(bodies.map((body) => body.reasoning)).toEqual([
      { effort: 'high', summary: 'auto' },
      { effort: 'high' },
    ]);
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

    await provider.entry.invocationPort.chat({
      model: 'one',
      messages: [],
    });
    await provider.entry.invocationPort.chat({
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
