import { describe, expect, it } from 'vitest';
import type { ModelInvocationPort } from '../../core/model-invocation/index.js';
import { ModelResolver } from '../../core/model-resolution/index.js';
import { createLegacyChildModelResolver } from './legacy-child.js';
import { createLegacyStaticModelResolver } from './legacy-static-config.js';

const invocationPort: ModelInvocationPort = {
  async *chatStream() { throw new Error('Not invoked by resolution tests.'); },
  async chat() { throw new Error('Not invoked by resolution tests.'); },
};

function resolver(): ModelResolver {
  return new ModelResolver([{
    id: 'test',
    protocol: 'test',
    invocationPort,
    resolveConnection: () => ({ ok: true, connection: { endpointId: 'test' } }),
    resolveModel: (modelId, connection) => ({
      ok: true,
      descriptor: {
        identity: { providerId: 'test', modelId },
        protocol: 'test',
        connection,
        facts: {
          effectiveContextLimit: { value: 200_000, source: 'legacy-config' },
          maximumOutputTokens: { value: 8192, source: 'deployment-config' },
        },
      },
    }),
  }]);
}

describe('legacy Model Resolution compatibility', () => {
  it('maps static Parent and inherited Child inputs into the same Resolver with distinct provenance', () => {
    const modelResolver = resolver();
    const parent = createLegacyStaticModelResolver({
      resolver: modelResolver,
      defaultProviderId: 'test',
      defaultModel: 'default-model',
      defaultMaxTokens: 4096,
    })({ tools: false, mediaKinds: [] });
    const child = createLegacyChildModelResolver({
      resolver: modelResolver,
      defaultProviderId: 'test',
      defaultModel: 'default-model',
      defaultMaxTokens: 4096,
    })({ model: 'inherit' });
    const native = modelResolver.resolve({
      reference: 'default-model',
      defaultProviderId: 'test',
      request: { tools: false, mediaKinds: [] },
      policy: { defaultMaxTokens: 4096 },
    });

    expect(parent.referenceSource).toBe('config-default');
    expect(child.referenceSource).toBe('legacy-child');
    expect(native.referenceSource).toBe('native');
    expect(parent.identity).toEqual(native.identity);
    expect(child.identity).toEqual(native.identity);
    expect(parent.invocationPort).toBe(native.invocationPort);
    expect(child.invocationPort).toBe(native.invocationPort);
    expect(parent.facts).toEqual(native.facts);
    expect(child.facts).toEqual(native.facts);
    expect(parent.limits).toEqual(native.limits);
    expect(child.limits).toEqual(native.limits);
  });
});
