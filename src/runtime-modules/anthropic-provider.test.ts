import { describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_COMPATIBLE_PROVIDER_ID } from '../adapters/provider/anthropic/index.js';
import {
  ANTHROPIC_PROVIDER_MODULE_ID,
  createAnthropicProviderModule,
} from './anthropic-provider.js';

describe('Anthropic Provider Runtime Module', () => {
  it('returns a required initially-enabled builtin Unit with stable identity', () => {
    const unit = createAnthropicProviderModule({ apiKey: 'test-key' });

    expect(unit).toEqual(expect.objectContaining({
      unitId: ANTHROPIC_PROVIDER_MODULE_ID,
      source: 'builtin',
      orderKey: ANTHROPIC_PROVIDER_MODULE_ID,
      required: true,
      initiallyEnabled: true,
      dependencies: [],
    }));
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.dependencies)).toBe(true);
  });

  it('defers Provider construction and validation until Unit create', () => {
    const unit = createAnthropicProviderModule({ baseURL: 'not-a-url' });

    expect(() => unit.create(new AbortController().signal)).toThrow(
      'Anthropic-compatible Provider endpoint is invalid.',
    );
  });

  it('encloses the Provider entry in the instance registration closure', async () => {
    const unit = createAnthropicProviderModule({
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-5',
    });
    const instance = await unit.create(new AbortController().signal);
    const registerProvider = vi.fn();

    instance.registration.register({ registerProvider } as never);

    expect(instance.registration).toEqual(expect.objectContaining({
      id: ANTHROPIC_PROVIDER_MODULE_ID,
      source: 'builtin',
    }));
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: ANTHROPIC_COMPATIBLE_PROVIDER_ID,
    }));
  });
});
