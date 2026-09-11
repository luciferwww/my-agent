import { describe, expect, it, vi } from 'vitest';
import type { ModelInvocationPort } from '../model-invocation/index.js';
import { ModelResolutionError, ModelResolver } from './ModelResolver.js';
import type { ModelResolutionInput, ProviderProjectionEntry } from './types.js';

const port: ModelInvocationPort = {
  chatStream: vi.fn(),
  chat: vi.fn(),
};

function provider(overrides: Partial<ProviderProjectionEntry> = {}): ProviderProjectionEntry {
  return {
    id: 'anthropic-compatible',
    models: [{ modelId: 'test-model' }],
    protocol: 'anthropic-messages',
    invocationPort: port,
    resolveConnection: () => ({
      ok: true,
      connection: { endpointId: 'https://example.test' },
    }),
    resolveModel: (modelId, connection) => ({
      ok: true,
      descriptor: {
        identity: { providerId: 'anthropic-compatible', modelId },
        protocol: 'anthropic-messages',
        connection,
        facts: {
          effectiveContextLimit: { value: 200_000, source: 'static-provider-catalog' },
          maximumOutputTokens: { value: 8192, source: 'static-provider-catalog' },
          toolUse: { value: true, source: 'static-provider-catalog' },
          mediaKinds: { value: ['image'], source: 'static-provider-catalog' },
        },
      },
    }),
    ...overrides,
  };
}

function input(overrides: Partial<ModelResolutionInput> = {}): ModelResolutionInput {
  return {
    reference: { providerId: 'anthropic-compatible', modelId: 'test-model' },
    request: { tools: false, mediaKinds: [] },
    policy: { defaultMaxTokens: 4096, maximumMaxTokens: 8192 },
    ...overrides,
  };
}

function expectCategory(action: () => unknown, category: ModelResolutionError['category']): void {
  try {
    action();
    throw new Error('Expected model resolution to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(ModelResolutionError);
    expect((error as ModelResolutionError).category).toBe(category);
  }
}

describe('ModelResolver', () => {
  it('atomically resolves an immutable identity, Port, Facts, provenance, and limits binding', () => {
    const resolver = new ModelResolver([provider()]);
    const resolved = resolver.resolve(input({ requestOverride: { maxOutputTokens: 2048 } }));

    expect(resolved.identity).toEqual({ providerId: 'anthropic-compatible', modelId: 'test-model' });
    expect(resolved.referenceSource).toBe('native');
    expect(resolved.invocationPort).toBe(port);
    expect(resolved.facts.effectiveContextLimit)
      .toEqual({ value: 200_000, source: 'static-provider-catalog' });
    expect(resolved.limits).toEqual({ maxTokens: 2048, maxTokensSource: 'request-override' });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.identity)).toBe(true);
    expect(Object.isFrozen(resolved.facts)).toBe(true);
    expect(Object.isFrozen(resolved.limits)).toBe(true);
  });

  it('preserves an opaque Provider-owned Model ID exactly through resolution', () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
    const resolveModel = vi.fn(provider().resolveModel);
    const resolver = new ModelResolver([provider({
      models: [{ modelId }],
      resolveModel,
    })]);

    const resolved = resolver.resolve(input({
      reference: { providerId: 'anthropic-compatible', modelId },
    }));

    expect(resolveModel).toHaveBeenCalledWith(modelId, { endpointId: 'https://example.test' });
    expect(resolved.identity.modelId).toBe(modelId);
  });

  it('distinguishes an empty Model ID from a missing Model ID', () => {
    const resolver = new ModelResolver([provider({ models: [{ modelId: '' }] })]);

    expect(resolver.resolve(input({
      reference: { providerId: 'anthropic-compatible', modelId: '' },
    })).identity.modelId).toBe('');
    expectCategory(() => resolver.resolve(input({
      reference: { providerId: 'anthropic-compatible' } as never,
    })), 'reference_invalid');
  });

  it('rejects a Provider descriptor that changes the selected opaque Model ID', () => {
    const base = provider();
    const resolver = new ModelResolver([provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return {
          ok: true,
          descriptor: {
            ...result.descriptor,
            identity: { ...result.descriptor.identity, modelId: 'different' },
          },
        };
      },
    })]);

    expectCategory(() => resolver.resolve(input()), 'protocol_incompatible');
  });

  it('validates application-owned Provider IDs without constraining Model IDs', () => {
    expect(() => new ModelResolver([provider({ id: 'provider/name' })]))
      .toThrow('invalid or duplicate identity');
    expectCategory(() => new ModelResolver([provider()]).resolve(input({
      reference: { providerId: 'provider/name', modelId: 'test-model' },
    })), 'reference_invalid');
  });

  it('rejects an invalid Provider ID returned by the Provider descriptor', () => {
    const base = provider();
    const resolver = new ModelResolver([provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return {
          ok: true,
          descriptor: {
            ...result.descriptor,
            identity: { providerId: 'provider/name', modelId },
          },
        };
      },
    })]);

    expectCategory(() => resolver.resolve(input()), 'protocol_incompatible');
  });

  it.each([
    ['reference_invalid', () => new ModelResolver([provider()]).resolve(input({ reference: { providerId: ' ', modelId: 'test-model' } }))],
    ['provider_unregistered', () => new ModelResolver([]).resolve(input())],
    ['connection_missing', () => new ModelResolver([provider({ resolveConnection: () => ({ ok: false, category: 'connection_missing', message: 'missing' }) })]).resolve(input())],
    ['connection_invalid', () => new ModelResolver([provider({ resolveConnection: () => ({ ok: false, category: 'connection_invalid', message: 'invalid' }) })]).resolve(input())],
    ['model_rejected', () => new ModelResolver([provider({ resolveModel: () => ({ ok: false, category: 'model_rejected', message: 'rejected' }) })]).resolve(input())],
    ['model_ambiguous', () => new ModelResolver([provider({ resolveModel: () => ({ ok: false, category: 'model_ambiguous', message: 'ambiguous' }) })]).resolve(input())],
    ['facts_insufficient', () => new ModelResolver([provider({ resolveModel: (modelId, connection) => ({ ok: true, descriptor: { identity: { providerId: 'anthropic-compatible', modelId }, protocol: 'anthropic-messages', connection, facts: {} } }) })]).resolve(input())],
    ['policy_denied', () => new ModelResolver([provider()]).resolve(input({ policy: { defaultMaxTokens: 4096, allowModel: () => false } }))],
    ['override_unauthorized', () => new ModelResolver([provider()]).resolve(input({ requestOverride: { maxOutputTokens: 9000 } }))],
    ['protocol_incompatible', () => new ModelResolver([provider({ protocol: 'other' })]).resolve(input())],
    ['capability_unsupported', () => new ModelResolver([provider()]).resolve(input({ request: { tools: false, mediaKinds: ['audio'] } }))],
  ] as const)('fails closed with %s before invoking the Port', (category, action) => {
    vi.mocked(port.chatStream).mockClear();
    vi.mocked(port.chat).mockClear();

    expectCategory(action, category);
    expect(port.chatStream).not.toHaveBeenCalled();
    expect(port.chat).not.toHaveBeenCalled();
  });

  it('rejects a model outside the closed Catalog before resolving a connection or model', () => {
    const resolveConnection = vi.fn(provider().resolveConnection);
    const resolveModel = vi.fn(provider().resolveModel);
    const resolver = new ModelResolver([provider({ resolveConnection, resolveModel })]);

    expectCategory(() => resolver.resolve(input({
      reference: { providerId: 'anthropic-compatible', modelId: 'not-published' },
    })), 'model_rejected');
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
