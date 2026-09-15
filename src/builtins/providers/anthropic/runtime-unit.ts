import {
  AnthropicCompatibleProvider,
  type AnthropicCompatibleProviderOptions,
} from './AnthropicCompatibleProvider.js';
import type { ExtensionRegistrationApi } from '../../../core/registry/index.js';
import type { LoadedRuntimeUnit } from '../../../runtime/runtime-unit.js';

export const ANTHROPIC_PROVIDER_UNIT_ID = 'builtin-anthropic-provider';

export type AnthropicProviderUnitOptions = AnthropicCompatibleProviderOptions;

export function createAnthropicProviderUnit(
  options: AnthropicProviderUnitOptions,
): LoadedRuntimeUnit {
  const capturedOptions = captureOptions(options);
  return Object.freeze({
    unitId: ANTHROPIC_PROVIDER_UNIT_ID,
    source: 'builtin' as const,
    orderKey: ANTHROPIC_PROVIDER_UNIT_ID,
    required: true,
    initiallyEnabled: true,
    dependencies: Object.freeze([]),
    create() {
      const provider = new AnthropicCompatibleProvider(capturedOptions);
      return Object.freeze({
        registration: Object.freeze({
          id: ANTHROPIC_PROVIDER_UNIT_ID,
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

function captureOptions(options: AnthropicProviderUnitOptions): AnthropicProviderUnitOptions {
  return Object.freeze({
    ...options,
    ...(options.deploymentFacts
      ? {
          deploymentFacts: Object.freeze(options.deploymentFacts.map((entry) => Object.freeze({
            ...entry,
            ...(entry.mediaKinds
              ? { mediaKinds: Object.freeze([...entry.mediaKinds]) }
              : {}),
          }))),
        }
      : {}),
  });
}