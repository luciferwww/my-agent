import { describe, expect, it, vi } from 'vitest';
import type { ProviderProjectionEntry } from 'my-agent/extension-api';
import {
  COPILOT_RELAY_PROVIDER_UNIT_ID,
  createCopilotRelayProviderUnit,
  normalizeCopilotRelayBaseURL,
} from './index.js';

function discoveryResponse(data: unknown[]): Response {
  return Response.json({ data });
}

function validModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    supported_endpoints: ['/responses', 'ws:/responses'],
    capabilities: {
      limits: {
        max_context_window_tokens: 1_050_000,
        max_prompt_tokens: 922_000,
        max_output_tokens: 128_000,
      },
      supports: { tool_calls: true, vision: true },
      supported_media_types: ['image/png', 'image/jpeg', 'application/pdf'],
    },
    ...overrides,
  };
}

async function createProvider(
  fetchImpl: typeof fetch,
  options: {
    baseURL?: string;
    apiKey?: string;
    discoveryTimeoutMs?: number;
    logger?: { warn: ReturnType<typeof vi.fn> };
  } = {},
): Promise<ProviderProjectionEntry> {
  const unit = createCopilotRelayProviderUnit({ ...options, fetch: fetchImpl });
  const instance = await unit.create(new AbortController().signal);
  let provider: ProviderProjectionEntry | undefined;
  instance.registration.register({
    registerProvider(entry: ProviderProjectionEntry) { provider = entry; },
  } as never);
  if (!provider) throw new Error('Provider was not registered.');
  return provider;
}

describe('Copilot Relay Provider Unit', () => {
  it('has stable optional external identity', () => {
    const unit = createCopilotRelayProviderUnit({ fetch: vi.fn() as never });
    expect(unit).toMatchObject({
      unitId: COPILOT_RELAY_PROVIDER_UNIT_ID,
      source: 'external',
      orderKey: COPILOT_RELAY_PROVIDER_UNIT_ID,
      required: false,
      initiallyEnabled: true,
      dependencies: [],
    });
    expect(Object.isFrozen(unit)).toBe(true);
  });

  it('discovers, filters, and freezes an endpoint-scoped Catalog', async () => {
    const logger = { warn: vi.fn() };
    const fetchImpl = vi.fn(async () => discoveryResponse([
      validModel({
        capabilities: {
          limits: {
            max_context_window_tokens: 1_050_000,
            max_prompt_tokens: 922_000,
            max_output_tokens: 128_000,
          },
          supports: {
            tool_calls: true,
            vision: true,
            reasoning_effort: ['high', 'ultra', 'low', 'medium'],
          },
          supported_media_types: ['image/png', 'image/jpeg', 'application/pdf'],
        },
      }),
      validModel({
        id: 'chat-only',
        supported_endpoints: ['/chat/completions'],
        capabilities: {
          limits: {
            max_context_window_tokens: 128_000,
            max_output_tokens: 8_192,
          },
          supports: { reasoning_effort: ['low', 'medium', 'high'] },
        },
      }),
      validModel({ id: 'no-supported-route', supported_endpoints: ['/messages'] }),
      validModel({ id: 'no-output', capabilities: { limits: { max_prompt_tokens: 10 } } }),
      validModel({ id: 'no-context', capabilities: { limits: { max_output_tokens: 10 } } }),
      validModel({ id: 42 }),
    ])) as unknown as typeof fetch;

    const provider = await createProvider(fetchImpl, {
      baseURL: 'http://localhost:5000/',
      apiKey: ' relay-secret ',
      logger,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:5000/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer relay-secret' }),
    }));
    expect(provider).toMatchObject({
      id: 'copilot-relay',
      displayName: 'Copilot Relay',
      protocol: 'copilot-relay-model-router',
      models: [
        {
          modelId: 'gpt-5.6-sol',
          displayName: 'GPT 5.6 Sol',
          capabilities: {
            toolUse: true,
            mediaKinds: ['image'],
            reasoning: { efforts: ['high', 'low', 'medium'] },
          },
        },
        {
          modelId: 'chat-only',
          displayName: 'GPT 5.6 Sol',
          capabilities: {
            reasoning: { efforts: ['low', 'medium', 'high'] },
          },
        },
      ],
    });
    expect(Object.isFrozen(provider.models)).toBe(true);
    expect(Object.isFrozen(provider.models[0])).toBe(true);
    const connection = provider.resolveConnection();
    expect(connection).toEqual({ ok: true, connection: { endpointId: 'http://localhost:5000' } });
    if (!connection.ok) throw new Error('Expected connection.');
    expect(provider.resolveModel('gpt-5.6-sol', connection.connection)).toMatchObject({
      ok: true,
      descriptor: {
        facts: {
          effectiveContextLimit: 922_000,
          maximumContextTokens: 1_050_000,
          maximumPromptTokens: 922_000,
          maximumOutputTokens: 128_000,
          toolUse: true,
          mediaKinds: ['image'],
          reasoning: { efforts: ['high', 'low', 'medium'] },
        },
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot Relay ignored unknown reasoning effort values.',
      { code: 'unknown_reasoning_effort', ignoredValueCount: 1 },
    );
  });

  it('binds dual-endpoint models to Responses and chat-only models to Chat without retry', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url);
      calls.push({
        url: text,
        ...(init?.body
          ? { body: JSON.parse(String(init.body)) as Record<string, unknown> }
          : {}),
      });
      if (text.endsWith('/v1/models')) {
        return discoveryResponse([
          validModel({
            id: 'dual',
            supported_endpoints: ['/chat/completions', '/responses'],
            capabilities: {
              limits: {
                max_context_window_tokens: 32_768,
                max_output_tokens: 4_096,
              },
              supports: { reasoning_effort: ['high'] },
            },
          }),
          validModel({
            id: 'chat-only',
            supported_endpoints: ['/chat/completions'],
            capabilities: {
              limits: {
                max_context_window_tokens: 32_768,
                max_output_tokens: 4_096,
              },
              supports: { reasoning_effort: ['low'] },
            },
          }),
        ]);
      }
      if (text.endsWith('/v1/responses')) {
        return new Response([
          `data: ${JSON.stringify({ type: 'response.created' })}\n\n`,
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''), { status: 200 });
      }
      return new Response([
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = await createProvider(fetchImpl);

    await provider.invocationPort.chat({
      model: 'dual',
      messages: [],
      reasoning: { effort: 'high' },
    });
    await provider.invocationPort.chat({
      model: 'chat-only',
      messages: [],
      reasoning: { effort: 'low' },
    });

    expect(calls.slice(1).map((call) => call.url)).toEqual([
      'http://127.0.0.1:5000/v1/responses',
      'http://127.0.0.1:5000/v1/chat/completions',
    ]);
    expect(calls[1]?.body?.reasoning).toEqual({ effort: 'high' });
    expect(calls[2]?.body?.reasoning_effort).toBe('low');
  });

  it('does not retry a dual-endpoint model through Chat after a Responses failure', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      urls.push(text);
      if (text.endsWith('/v1/models')) {
        return discoveryResponse([validModel({
          supported_endpoints: ['/responses', '/chat/completions'],
        })]);
      }
      return Response.json(
        { error: { type: 'server_error', message: 'failed' } },
        { status: 500 },
      );
    }) as unknown as typeof fetch;
    const provider = await createProvider(fetchImpl);

    await expect(provider.invocationPort.chat({
      model: 'gpt-5.6-sol',
      messages: [],
    })).rejects.toMatchObject({ category: 'unavailable' });
    expect(urls).toEqual([
      'http://127.0.0.1:5000/v1/models',
      'http://127.0.0.1:5000/v1/responses',
    ]);
  });

  it('preserves an arbitrary opaque Model ID from discovery through resolution', async () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
    const provider = await createProvider(
      vi.fn(async () => discoveryResponse([validModel({ id: modelId })])) as unknown as typeof fetch,
    );

    expect(provider.models).toEqual([{
      modelId,
      displayName: 'GPT 5.6 Sol',
      capabilities: { toolUse: true, mediaKinds: ['image'] },
    }]);
    const connection = provider.resolveConnection();
    if (!connection.ok) throw new Error('Expected connection.');
    const resolved = provider.resolveModel(modelId, connection.connection);
    expect(resolved).toMatchObject({
      ok: true,
      descriptor: { identity: { providerId: 'copilot-relay', modelId } },
    });
    expect(provider.resolveModel(modelId.trim(), connection.connection)).toMatchObject({
      ok: false,
      category: 'model_rejected',
    });
  });

  it('preserves whether discovery supplied a Prompt limit or only a Context limit', async () => {
    const provider = await createProvider(
      vi.fn(async () => discoveryResponse([
        validModel({
          id: 'context-only',
          capabilities: {
            limits: {
              max_context_window_tokens: 32_768,
              max_output_tokens: 2_048,
            },
          },
        }),
        validModel({
          id: 'prompt-only',
          capabilities: {
            limits: {
              max_prompt_tokens: 24_000,
              max_output_tokens: 2_048,
            },
          },
        }),
      ])) as unknown as typeof fetch,
    );
    const connection = provider.resolveConnection();
    if (!connection.ok) throw new Error('Expected connection.');

    const contextOnly = provider.resolveModel('context-only', connection.connection);
    if (!contextOnly.ok) throw new Error('Expected context-only model.');
    expect(contextOnly.descriptor.facts).toMatchObject({
      effectiveContextLimit: 32_768,
      maximumContextTokens: 32_768,
      maximumOutputTokens: 2_048,
    });
    expect(contextOnly.descriptor.facts.maximumPromptTokens).toBeUndefined();

    const promptOnly = provider.resolveModel('prompt-only', connection.connection);
    if (!promptOnly.ok) throw new Error('Expected prompt-only model.');
    expect(promptOnly.descriptor.facts).toMatchObject({
      effectiveContextLimit: 24_000,
      maximumPromptTokens: 24_000,
      maximumOutputTokens: 2_048,
    });
    expect(promptOnly.descriptor.facts.maximumContextTokens).toBeUndefined();
  });

  it('preserves an empty string Model ID from discovery through resolution', async () => {
    const provider = await createProvider(
      vi.fn(async () => discoveryResponse([validModel({ id: '' })])) as unknown as typeof fetch,
    );
    const connection = provider.resolveConnection();
    if (!connection.ok) throw new Error('Expected connection.');

    expect(provider.models).toEqual([{
      modelId: '',
      displayName: 'GPT 5.6 Sol',
      capabilities: { toolUse: true, mediaKinds: ['image'] },
    }]);
    expect(provider.resolveModel('', connection.connection)).toMatchObject({
      ok: true,
      descriptor: { identity: { modelId: '' } },
    });
  });

  it('omits authorization when the key is blank', async () => {
    const fetchImpl = vi.fn(async () => discoveryResponse([validModel()])) as unknown as typeof fetch;
    await createProvider(fetchImpl, { apiKey: '   ' });
    const headers = vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
  });

  it('rejects duplicate eligible model ids and malformed discovery responses', async () => {
    await expect(createProvider(
      vi.fn(async () => discoveryResponse([validModel(), validModel()])) as unknown as typeof fetch,
    )).rejects.toThrow('duplicate model id');
    await expect(createProvider(
      vi.fn(async () => Response.json({ models: [] })) as unknown as typeof fetch,
    )).rejects.toThrow('data array');
  });

  it.each([
    true,
    {},
    ['high', 1],
    ['high', ' '],
    ['high', 'high'],
  ])('rejects structurally invalid reasoning_effort metadata %j', async (reasoningEffort) => {
    await expect(createProvider(
      vi.fn(async () => discoveryResponse([validModel({
        capabilities: {
          limits: {
            max_context_window_tokens: 32_768,
            max_output_tokens: 4_096,
          },
          supports: { reasoning_effort: reasoningEffort },
        },
      })])) as unknown as typeof fetch,
    )).rejects.toThrow('reasoning_effort');
  });

  it('keeps an all-unknown effort model without publishing explicit effort capability', async () => {
    const logger = { warn: vi.fn() };
    const provider = await createProvider(
      vi.fn(async () => discoveryResponse([validModel({
        capabilities: {
          limits: {
            max_context_window_tokens: 32_768,
            max_output_tokens: 4_096,
          },
          supports: { reasoning_effort: ['ultra'] },
        },
      })])) as unknown as typeof fetch,
      { logger },
    );

    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]?.capabilities?.reasoning).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      { code: 'unknown_reasoning_effort', ignoredValueCount: 1 },
    );
  });

  it('cancels a non-success discovery response body', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel,
    }), { status: 503 })) as unknown as typeof fetch;
    await expect(createProvider(fetchImpl)).rejects.toThrow('HTTP 503');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('reports the discovery target and transport cause', async () => {
    const failure = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:5000'),
    });
    const fetchImpl = vi.fn(async () => { throw failure; }) as unknown as typeof fetch;

    await expect(createProvider(fetchImpl)).rejects.toThrow(
      'Copilot Relay model discovery request to "http://127.0.0.1:5000/v1/models" failed: connect ECONNREFUSED 127.0.0.1:5000',
    );
  });

  it('aborts bounded discovery at its timeout', async () => {
    const fetchImpl = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const unit = createCopilotRelayProviderUnit({ fetch: fetchImpl, discoveryTimeoutMs: 10 });
    await expect(unit.create(new AbortController().signal)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('aborts discovery while a response body read is pending', async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {},
    }))) as unknown as typeof fetch;
    const unit = createCopilotRelayProviderUnit({ fetch: fetchImpl, discoveryTimeoutMs: 10 });
    await expect(unit.create(new AbortController().signal)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('validates HTTP(S) base URLs before discovery', () => {
    expect(normalizeCopilotRelayBaseURL('http://127.0.0.1:5000///'))
      .toBe('http://127.0.0.1:5000');
    expect(normalizeCopilotRelayBaseURL('http://192.168.1.14:5000'))
      .toBe('http://192.168.1.14:5000');
    expect(normalizeCopilotRelayBaseURL('https://relay.example.com'))
      .toBe('https://relay.example.com');
    expect(() => normalizeCopilotRelayBaseURL('ftp://relay.example.com'))
      .toThrow('HTTP(S)');
    expect(() => normalizeCopilotRelayBaseURL('http://user:secret@localhost:5000'))
      .toThrow('credential-free');
    expect(() => normalizeCopilotRelayBaseURL('http://localhost:5000?secret=yes'))
      .toThrow('without query or fragment');
  });
});
