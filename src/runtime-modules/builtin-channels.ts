import { CliChannel, type CliChannelConfig } from '../adapters/channel/CliChannel.js';
import {
  WebSocketChannel,
  type WebSocketChannelConfig,
} from '../adapters/channel/WebSocketChannel.js';
import type {
  ExtensionRegistrationApi,
  RuntimeContributionUnit,
} from '../core/registry/index.js';

export function createCliChannelModule(
  config: CliChannelConfig = {},
): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-cli-channel',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerChannel(Object.freeze({
        id: 'cli',
        create: () => new CliChannel(config),
      }));
    },
  });
}

export function createWebSocketChannelModule(
  config: WebSocketChannelConfig,
): RuntimeContributionUnit {
  assertWebSocketConfig(config);
  return Object.freeze({
    id: 'builtin-websocket-channel',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerChannel(Object.freeze({
        id: 'websocket',
        create: () => new WebSocketChannel(config),
      }));
    },
  });
}

function assertWebSocketConfig(config: WebSocketChannelConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error(`WebSocket Channel port must be an integer from 0 to 65535. Received: ${config.port}`);
  }
  if (config.path !== undefined && !config.path.startsWith('/')) {
    throw new Error(`WebSocket Channel path must start with "/". Received: ${config.path}`);
  }
  if (
    config.maxClients !== undefined
    && (!Number.isInteger(config.maxClients) || config.maxClients <= 0)
  ) {
    throw new Error(`WebSocket Channel maxClients must be a positive integer. Received: ${config.maxClients}`);
  }
}
