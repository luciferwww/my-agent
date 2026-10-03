import { describe, expect, it, vi } from 'vitest';
import type { ExtensionRegistrationApi } from '../../../core/registry/index.js';
import {
  BUILTIN_LLM_PROVIDER_UNIT_ID,
  createBuiltinLlmProviderUnit,
} from './runtime-unit.js';

describe('Built-in LLM Provider Runtime Unit', () => {
  it('captures configuration and publishes the Built-in Provider through registration', async () => {
    const createClient = vi.fn(() => ({}) as never);
    const config = {
      baseURL: 'https://example.test/v1',
      models: [{
        modelId: 'model-a',
        protocol: 'openai-responses' as const,
        displayName: 'Model A',
      }],
    };
    const unit = createBuiltinLlmProviderUnit(config, { createClient });
    config.models[0]!.modelId = 'changed';

    expect(unit).toMatchObject({
      unitId: BUILTIN_LLM_PROVIDER_UNIT_ID,
      source: 'builtin',
      orderKey: BUILTIN_LLM_PROVIDER_UNIT_ID,
      required: true,
      initiallyEnabled: true,
      dependencies: [],
    });

    const instance = await unit.create(new AbortController().signal);
    const registerProvider = vi.fn();
    instance.registration.register({ registerProvider } as unknown as ExtensionRegistrationApi);

    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'builtin',
      models: [{ modelId: 'model-a', displayName: 'Model A' }],
    }));
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('publishes an empty Catalog without creating a Protocol Client', async () => {
    const createClient = vi.fn();
    const unit = createBuiltinLlmProviderUnit({
      baseURL: 'https://example.test/v1',
      models: [],
    }, { createClient });
    const instance = await unit.create(new AbortController().signal);
    const registerProvider = vi.fn();

    instance.registration.register({ registerProvider } as unknown as ExtensionRegistrationApi);

    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'builtin',
      models: [],
    }));
    expect(createClient).not.toHaveBeenCalled();
  });
});
