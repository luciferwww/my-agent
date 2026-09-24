import {
  createLoadedRuntimeUnit,
  type ExtensionLogger,
  type ExtensionRegistrationApi,
  type LoadedRuntimeUnit,
} from 'my-agent/extension-api';

import { WebSocketChannel, type BrowserLauncher } from './WebSocketChannel.js';
import type { WebSocketExtensionConfig } from './config.js';

export interface WebSocketChannelUnitOptions {
  readonly config: WebSocketExtensionConfig;
  readonly clientFilePath: string;
  readonly logger: ExtensionLogger;
  readonly browserLauncher?: BrowserLauncher;
}

export function createWebSocketChannelUnit(
  options: WebSocketChannelUnitOptions,
): LoadedRuntimeUnit {
  return createLoadedRuntimeUnit({
    registration: Object.freeze({
      id: 'websocket-channel',
      source: 'external' as const,
      register(api: ExtensionRegistrationApi) {
        api.registerChannel(Object.freeze({
          id: 'websocket',
          create: () => new WebSocketChannel(options),
        }));
      },
    }),
    required: false,
  });
}
