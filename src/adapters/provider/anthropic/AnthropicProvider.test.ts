import { describe, expect, it } from 'vitest';
import { ModelResolutionError, ModelResolver } from '../../../core/model-resolution/index.js';
import {
  ANTHROPIC_COMPATIBLE_PROVIDER_ID,
  ANTHROPIC_MESSAGES_PROTOCOL,
  AnthropicProvider,
} from './AnthropicProvider.js';

function resolve(provider: AnthropicProvider, modelId: string, tools = false) {
  return new ModelResolver([provider.entry]).resolve({
    reference: modelId,
    defaultProviderId: ANTHROPIC_COMPATIBLE_PROVIDER_ID,
    request: { tools, mediaKinds: [] },
    policy: { defaultMaxTokens: 2048 },
  });
}

describe('AnthropicProvider', () => {
  it('uses exact Provider-owned static facts for a current model on the official endpoint', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });

    const resolved = resolve(provider, 'claude-sonnet-5', true);
    expect(resolved.facts.effectiveContextLimit)
      .toEqual({ value: 1_000_000, source: 'static-provider-catalog' });
    expect(resolved.facts.maximumOutputTokens)
      .toEqual({ value: 128_000, source: 'static-provider-catalog' });
    expect(resolved.facts.toolUse)
      .toEqual({ value: true, source: 'static-provider-catalog' });
  });

  it('applies deployment facts only to the exact Provider, Endpoint, and Model scope', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.test/',
      defaultModel: 'custom-model',
      legacyContextWindowTokens: 100_000,
      deploymentFacts: [{
        providerId: ANTHROPIC_COMPATIBLE_PROVIDER_ID,
        endpointId: 'https://proxy.example.test',
        modelId: 'custom-model',
        protocol: ANTHROPIC_MESSAGES_PROTOCOL,
        maximumOutputTokens: 4096,
        toolUse: true,
        mediaKinds: [],
      }],
    });

    const resolved = resolve(provider, 'custom-model', true);
    expect(resolved.endpointId).toBe('https://proxy.example.test');
    expect(resolved.facts.effectiveContextLimit).toEqual({ value: 100_000, source: 'legacy-config' });
    expect(resolved.facts.maximumOutputTokens).toEqual({ value: 4096, source: 'deployment-config' });
    expect(resolved.facts.toolUse).toEqual({ value: true, source: 'deployment-config' });
  });

  it('fails closed for an unknown model without an explicit maximum-output fact', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.test',
      defaultModel: 'custom-model',
      legacyContextWindowTokens: 100_000,
    });

    expect(() => resolve(provider, 'custom-model')).toThrowError(ModelResolutionError);
    try {
      resolve(provider, 'custom-model');
    } catch (error) {
      expect((error as ModelResolutionError).category).toBe('facts_insufficient');
    }
  });

  it('rejects invalid or non-Anthropic deployment-facts input at startup', () => {
    expect(() => new AnthropicProvider({
      apiKey: 'test-key',
      deploymentFacts: [{
        providerId: 'other',
        endpointId: 'https://api.anthropic.com',
        modelId: 'custom-model',
        protocol: ANTHROPIC_MESSAGES_PROTOCOL,
        maximumOutputTokens: 4096,
      }],
    })).toThrow('Invalid Anthropic-compatible deployment-facts entry.');
  });
});