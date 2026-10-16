import {
  createLoadedRuntimeUnit,
  type ExtensionRegistrationApi,
  type LoadedRuntimeUnit,
} from 'my-agent/extension-api';

import {
  WebSocketChannel,
  type WebSocketChannelOptions,
} from './WebSocketChannel.js';

export type WebSocketChannelUnitOptions = WebSocketChannelOptions;

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
