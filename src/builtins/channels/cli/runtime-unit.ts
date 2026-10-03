import type { ExtensionRegistrationApi } from '../../../core/registry/index.js';
import { createLoadedRuntimeUnit, type LoadedRuntimeUnit } from '../../../runtime/runtime-unit.js';
import { CliChannel, type CliChannelConfig } from './CliChannel.js';

export function createCliChannelUnit(
  config: CliChannelConfig = {},
): LoadedRuntimeUnit {
  return createLoadedRuntimeUnit({
    registration: Object.freeze({
      id: 'builtin-cli-channel',
      source: 'builtin' as const,
      register(api: ExtensionRegistrationApi) {
        api.registerChannel(Object.freeze({
          id: 'cli',
          create: () => new CliChannel(config),
        }));
      },
    }),
    required: false,
  });
}
