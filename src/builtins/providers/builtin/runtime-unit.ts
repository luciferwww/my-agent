import type { ExtensionRegistrationApi } from '../../../core/registry/index.js';
import type { LoadedRuntimeUnit } from '../../../runtime/runtime-unit.js';
import { BuiltinLlmProvider, type BuiltinLlmProviderOptions } from './BuiltinLlmProvider.js';
import type { BuiltinLlmProviderConfig } from './config.js';

export const BUILTIN_LLM_PROVIDER_UNIT_ID = 'builtin-llm-provider';

export function createBuiltinLlmProviderUnit(
  config: BuiltinLlmProviderConfig,
  options: BuiltinLlmProviderOptions = {},
): LoadedRuntimeUnit {
  const capturedConfig = captureConfig(config);
  const capturedOptions = Object.freeze({ ...options });
  return Object.freeze({
    unitId: BUILTIN_LLM_PROVIDER_UNIT_ID,
    source: 'builtin' as const,
    orderKey: BUILTIN_LLM_PROVIDER_UNIT_ID,
    required: true,
    initiallyEnabled: true,
    dependencies: Object.freeze([]),
    create() {
      const provider = new BuiltinLlmProvider(capturedConfig, capturedOptions);
      return Object.freeze({
        registration: Object.freeze({
          id: BUILTIN_LLM_PROVIDER_UNIT_ID,
          source: 'builtin' as const,
          register(api: ExtensionRegistrationApi) {
            api.registerProvider(provider.entry);
          },
        }),
        start() {},
        stop() {},
      });
    },
  });
}

function captureConfig(config: BuiltinLlmProviderConfig): BuiltinLlmProviderConfig {
  return Object.freeze({
    baseURL: config.baseURL,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    models: Object.freeze(config.models.map((model) => Object.freeze({ ...model }))),
  });
}
