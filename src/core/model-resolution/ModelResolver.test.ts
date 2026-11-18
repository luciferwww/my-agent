import { describe, expect, it, vi } from 'vitest';
import type { ModelInvocationPort } from '../model-invocation/index.js';
import { ModelResolutionError, ModelResolver } from './ModelResolver.js';
import type {
  ModelResolutionInput,
  ProviderModelFacts,
  ProviderModelSnapshot,
  ProviderProjectionEntry,
} from './types.js';

const port: ModelInvocationPort = {
  chatStream: vi.fn(),
  chat: vi.fn(),
};

function provider(overrides: Partial<ProviderProjectionEntry & ProviderModelSnapshot> = {}): ProviderProjectionEntry {
  return {
    id: 'test-provider',
    getModelCatalog: async () => ({ models: [{ modelId: 'test-model' }], resolveModel: (modelId, connection) => ({
      ok: true,
      descriptor: { invocationPort: port,
        identity: { providerId: 'test-provider', modelId },
        protocol: 'anthropic-messages',
        connection,
        invocationDefaults: {
          outputTokenLimit: 16_384,
        },
        facts: {
          effectiveContextLimit: 200_000,
          maximumContextTokens: 200_000,
          maximumPromptTokens: 190_000,
          maximumOutputTokens: 8192,
          toolUse: true,
          mediaKinds: ['image'],
        },
      },
    }), ...overrides }),
    protocol: 'anthropic-messages',

    resolveConnection: () => ({
      ok: true,
      connection: { endpointId: 'https://example.test' },
    }),

    ...overrides,
  };
}

function input(overrides: Partial<ModelResolutionInput> = {}): ModelResolutionInput {
  return {
    reference: { providerId: 'test-provider', modelId: 'test-model' },
    request: { tools: false, mediaKinds: [] },
    policy: {},
    ...overrides,
  };
}

async function expectCategory(action: () => unknown, category: ModelResolutionError['category']): Promise<void> {
  try {
    await action();
    throw new Error('Expected model resolution to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(ModelResolutionError);
    expect((error as ModelResolutionError).category).toBe(category);
  }
}

describe('ModelResolver', () => {
  it('atomically resolves an immutable identity, Port, and plain Facts binding', async () => {
    const resolver = new ModelResolver([provider()]);
    const resolved = (await resolver.resolve(input()));

    expect(resolved.identity).toEqual({ providerId: 'test-provider', modelId: 'test-model' });
    expect(resolved.referenceSource).toBe('native');
    expect(resolved.invocationPort).toBe(port);
    expect(resolved.invocationDefaults.outputTokenLimit).toBe(8192);
    expect(resolved.facts.effectiveContextLimit).toBe(200_000);
    expect(resolved.facts.maximumContextTokens).toBe(200_000);
    expect(resolved.facts.maximumPromptTokens).toBe(190_000);
    expect(resolved.facts.maximumOutputTokens).toBe(8192);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.identity)).toBe(true);
    expect(Object.isFrozen(resolved.invocationDefaults)).toBe(true);
    expect(Object.isFrozen(resolved.facts)).toBe(true);
  });

  it('preserves an opaque Provider-owned Model ID exactly through resolution', async () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
    const resolveModel = vi.fn((await provider().getModelCatalog()).resolveModel);
    const resolver = new ModelResolver([provider({
      models: [{ modelId }],
      resolveModel,
    })]);

    const resolved = (await resolver.resolve(input({
      reference: { providerId: 'test-provider', modelId },
    })));

    expect(resolveModel).toHaveBeenCalledWith(modelId, { endpointId: 'https://example.test' });
    expect(resolved.identity.modelId).toBe(modelId);
  });

  it('distinguishes an empty Model ID from a missing Model ID', async () => {
    const resolver = new ModelResolver([provider({ models: [{ modelId: '' }] })]);

    expect((await resolver.resolve(input({
      reference: { providerId: 'test-provider', modelId: '' },
    }))).identity.modelId).toBe('');
    await expectCategory(async () => (await resolver.resolve(input({
      reference: { providerId: 'test-provider' } as never,
    }))), 'reference_invalid');
  });

  it('rejects a Provider descriptor that changes the selected opaque Model ID', async () => {
    const base = await provider().getModelCatalog();
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

    await expectCategory(async () => (await resolver.resolve(input())), 'protocol_incompatible');
  });

  it('validates application-owned Provider IDs without constraining Model IDs', async () => {
    expect(() => new ModelResolver([provider({ id: 'provider/name' })]))
      .toThrow('invalid or duplicate identity');
    await expectCategory(async () => (await new ModelResolver([provider()]).resolve(input({
      reference: { providerId: 'provider/name', modelId: 'test-model' },
    }))), 'reference_invalid');
  });

  it('rejects an invalid Provider ID returned by the Provider descriptor', async () => {
    const base = await provider().getModelCatalog();
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

    await expectCategory(async () => (await resolver.resolve(input())), 'protocol_incompatible');
  });

  it.each([
    ['reference_invalid', async () => (await new ModelResolver([provider()]).resolve(input({ reference: { providerId: ' ', modelId: 'test-model' } })))],
    ['provider_unregistered', async () => (await new ModelResolver([]).resolve(input()))],
    ['connection_missing', async () => (await new ModelResolver([provider({ resolveConnection: () => ({ ok: false, category: 'connection_missing', message: 'missing' }) })]).resolve(input()))],
    ['connection_invalid', async () => (await new ModelResolver([provider({ resolveConnection: () => ({ ok: false, category: 'connection_invalid', message: 'invalid' }) })]).resolve(input()))],
    ['model_rejected', async () => (await new ModelResolver([provider({ resolveModel: () => ({ ok: false, category: 'model_rejected', message: 'rejected' }) })]).resolve(input()))],
    ['model_ambiguous', async () => (await new ModelResolver([provider({ resolveModel: () => ({ ok: false, category: 'model_ambiguous', message: 'ambiguous' }) })]).resolve(input()))],
    ['facts_insufficient', async () => (await new ModelResolver([provider({ resolveModel: (modelId, connection) => ({ ok: true, descriptor: { invocationPort: port, identity: { providerId: 'test-provider', modelId }, protocol: 'anthropic-messages', connection, facts: {} } }) })]).resolve(input()))],
    ['policy_denied', async () => (await new ModelResolver([provider()]).resolve(input({ policy: { allowModel: () => false } })))],
    ['protocol_incompatible', async () => (await new ModelResolver([provider({ protocol: 'other' })]).resolve(input()))],
    ['capability_unsupported', async () => (await new ModelResolver([provider()]).resolve(input({ request: { tools: false, mediaKinds: ['audio'] } })))],
  ] as const)('fails closed with %s before invoking the Port', async (category, action) => {
    vi.mocked(port.chatStream).mockClear();
    vi.mocked(port.chat).mockClear();

    await expectCategory(action, category);
    expect(port.chatStream).not.toHaveBeenCalled();
    expect(port.chat).not.toHaveBeenCalled();
  });

  it('fails open for unknown Tool and Media capabilities', async () => {
    const base = await provider().getModelCatalog();
    const resolver = new ModelResolver([provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return {
          ok: true,
          descriptor: {
            ...result.descriptor,
            facts: { effectiveContextLimit: 32_768 },
          },
        };
      },
    })]);

    expect(async () => (await resolver.resolve(input({
      request: { tools: true, mediaKinds: ['image'] },
    })))).not.toThrow();
  });

  it('defensively copies and deeply freezes valid reasoning capabilities', async () => {
    const base = await provider().getModelCatalog();
    const thinking: Array<'off' | 'on'> = ['off', 'on'];
    const efforts: Array<'high' | 'low'> = ['high', 'low'];
    const resolver = new ModelResolver([provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return {
          ok: true,
          descriptor: {
            ...result.descriptor,
            facts: {
              ...result.descriptor.facts,
              reasoning: { thinking, efforts },
            },
          },
        };
      },
    })]);

    const resolved = (await resolver.resolve(input()));
    thinking.reverse();
    efforts.reverse();

    expect(resolved.facts.reasoning).toEqual({
      thinking: ['off', 'on'],
      efforts: ['high', 'low'],
    });
    expect(Object.isFrozen(resolved.facts.reasoning)).toBe(true);
    expect(Object.isFrozen(resolved.facts.reasoning?.thinking)).toBe(true);
    expect(Object.isFrozen(resolved.facts.reasoning?.efforts)).toBe(true);
  });

  it.each([
    { efforts: ['default'] },
    { efforts: ['high', 'high'] },
    { thinking: ['on', 'unknown'] },
    { thinking: 'on' },
    { unknown: [] },
  ])('rejects invalid reasoning capabilities %#', async (reasoning) => {
    const base = await provider().getModelCatalog();
    const resolver = new ModelResolver([provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return {
          ok: true,
          descriptor: {
            ...result.descriptor,
            facts: {
              ...result.descriptor.facts,
              reasoning: reasoning as never,
            },
          },
        };
      },
    })]);

    await expectCategory(async () => (await resolver.resolve(input())), 'facts_insufficient');
  });

  it('rejects explicit negative Tool and Media capabilities', async () => {
    const base = await provider().getModelCatalog();
    const withFacts = (facts: ProviderModelFacts) => provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return { ok: true, descriptor: { ...result.descriptor, facts } };
      },
    });

    await expectCategory(async () => (await new ModelResolver([withFacts({
      effectiveContextLimit: 32_768,
      toolUse: false,
    })]).resolve(input({ request: { tools: true, mediaKinds: [] } }))), 'capability_unsupported');
    await expectCategory(async () => (await new ModelResolver([withFacts({
      effectiveContextLimit: 32_768,
      mediaKinds: [],
    })]).resolve(input({ request: { tools: false, mediaKinds: ['image'] } }))), 'capability_unsupported');
  });

  it('rejects invalid or Context-inconsistent optional model limits', async () => {
    const base = await provider().getModelCatalog();
    const withFacts = (facts: ProviderModelFacts) => provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return { ok: true, descriptor: { ...result.descriptor, facts } };
      },
    });

    for (const facts of [
      { effectiveContextLimit: 100, maximumContextTokens: 0 },
      { effectiveContextLimit: 100, maximumPromptTokens: 1.5 },
      {
        effectiveContextLimit: 100,
        maximumContextTokens: 100,
        maximumPromptTokens: 101,
      },
      {
        effectiveContextLimit: 100,
        maximumContextTokens: 100,
        maximumOutputTokens: 101,
      },
    ]) {
      await expectCategory(
        async () => (await new ModelResolver([withFacts(facts)]).resolve(input())),
        'facts_insufficient',
      );
    }
  });

  it('rejects invalid invocation defaults', async () => {
    const base = await provider().getModelCatalog();
    const resolver = new ModelResolver([provider({
      resolveModel: (modelId, connection) => {
        const result = base.resolveModel(modelId, connection);
        if (!result.ok) return result;
        return {
          ok: true,
          descriptor: {
            ...result.descriptor,
            invocationDefaults: { outputTokenLimit: 0 },
          },
        };
      },
    })]);

    await expectCategory(async () => (await resolver.resolve(input())), 'facts_insufficient');
  });

  it('rejects a model outside the closed Catalog before resolving a connection or model', async () => {
    const resolveConnection = vi.fn(provider().resolveConnection);
    const resolveModel = vi.fn((await provider().getModelCatalog()).resolveModel);
    const resolver = new ModelResolver([provider({ resolveConnection, resolveModel })]);

    await expectCategory(async () => (await resolver.resolve(input({
      reference: { providerId: 'test-provider', modelId: 'not-published' },
    }))), 'model_rejected');
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
  });
});
