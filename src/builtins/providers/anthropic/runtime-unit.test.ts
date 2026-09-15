import { describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_COMPATIBLE_PROVIDER_ID } from './AnthropicCompatibleProvider.js';
import {
  ANTHROPIC_PROVIDER_UNIT_ID,
  createAnthropicProviderUnit,
} from './runtime-unit.js';

describe('Anthropic Provider Runtime Unit', () => {
  it('returns a required initially-enabled builtin Unit with stable identity', () => {
    const unit = createAnthropicProviderUnit({ apiKey: 'test-key' });

    expect(unit).toEqual(expect.objectContaining({
      unitId: ANTHROPIC_PROVIDER_UNIT_ID,
      source: 'builtin',
      orderKey: ANTHROPIC_PROVIDER_UNIT_ID,
      required: true,
      initiallyEnabled: true,
      dependencies: [],
    }));
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.dependencies)).toBe(true);
  });

  it('defers Provider construction and validation until Unit create', () => {
    const unit = createAnthropicProviderUnit({ baseURL: 'not-a-url' });

    expect(() => unit.create(new AbortController().signal)).toThrow(
      'Anthropic-compatible Provider endpoint is invalid.',
    );
  });

  it('encloses the Provider entry in the instance registration closure', async () => {
    const unit = createAnthropicProviderUnit({
      apiKey: 'test-key',
    });
    const instance = await unit.create(new AbortController().signal);
    const registerProvider = vi.fn();

    instance.registration.register({ registerProvider } as never);

    expect(instance.registration).toEqual(expect.objectContaining({
      id: ANTHROPIC_PROVIDER_UNIT_ID,
      source: 'builtin',
    }));
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: ANTHROPIC_COMPATIBLE_PROVIDER_ID,
      models: expect.arrayContaining([expect.objectContaining({ modelId: expect.any(String) })]),
    }));
  });
});
