import { describe, expect, it, vi } from 'vitest';
import type { ProviderProjectionEntry } from '../../core/model-resolution/index.js';
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
  options: { baseURL?: string; apiKey?: string; discoveryTimeoutMs?: number } = {},
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
    const fetchImpl = vi.fn(async () => discoveryResponse([
      validModel(),
      validModel({ id: 'no-responses', supported_endpoints: ['/chat/completions'] }),
      validModel({ id: 'no-output', capabilities: { limits: { max_prompt_tokens: 10 } } }),
      validModel({ id: 'no-context', capabilities: { limits: { max_output_tokens: 10 } } }),
      validModel({ id: ' ' }),
    ])) as unknown as typeof fetch;

    const provider = await createProvider(fetchImpl, {
      baseURL: 'http://localhost:5000/',
      apiKey: ' relay-secret ',
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:5000/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer relay-secret' }),
    }));
    expect(provider).toMatchObject({
      id: 'copilot-relay',
      displayName: 'Copilot Relay',
      protocol: 'openai-responses',
      models: [{ modelId: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol' }],
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
          effectiveContextLimit: { value: 922_000, source: 'provider-metadata' },
          maximumOutputTokens: { value: 128_000, source: 'provider-metadata' },
          toolUse: { value: true, source: 'provider-metadata' },
          mediaKinds: { value: ['image'], source: 'provider-metadata' },
        },
      },
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

  it('cancels a non-success discovery response body', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel,
    }), { status: 503 })) as unknown as typeof fetch;
    await expect(createProvider(fetchImpl)).rejects.toThrow('HTTP 503');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
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

  it('validates loopback base URLs before discovery', () => {
    expect(normalizeCopilotRelayBaseURL('http://127.0.0.1:5000///'))
      .toBe('http://127.0.0.1:5000');
    expect(() => normalizeCopilotRelayBaseURL('https://relay.example.com'))
      .toThrow('loopback');
    expect(() => normalizeCopilotRelayBaseURL('http://user:secret@localhost:5000'))
      .toThrow('credential-free');
    expect(() => normalizeCopilotRelayBaseURL('http://localhost:5000?secret=yes'))
      .toThrow('without query or fragment');
  });
});
