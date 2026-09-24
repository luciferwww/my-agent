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
