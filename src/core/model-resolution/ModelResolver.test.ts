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
          effectiveContextLimit: { value: 200_000, source: 'legacy-config' },
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
    reference: 'test-model',
    defaultProviderId: 'anthropic-compatible',
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
    expect(resolved.facts.effectiveContextLimit).toEqual({ value: 200_000, source: 'legacy-config' });
    expect(resolved.limits).toEqual({ maxTokens: 2048, maxTokensSource: 'request-override' });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.identity)).toBe(true);
    expect(Object.isFrozen(resolved.facts)).toBe(true);
    expect(Object.isFrozen(resolved.limits)).toBe(true);
  });

  it.each([
    ['reference_invalid', () => new ModelResolver([provider()]).resolve(input({ reference: '  ' }))],
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
});
