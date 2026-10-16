import { fileURLToPath } from 'node:url';

import type { ExtensionLoadContext, LoadedRuntimeUnit } from 'my-agent/extension-api';

import { readWebSocketExtensionConfig } from './config.js';
import { createWebSocketChannelUnit } from './websocket-channel-unit.js';

export function createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit {
  return createWebSocketChannelUnit({
    config: readWebSocketExtensionConfig(context.config),
    clientAssetDirectoryPath: fileURLToPath(new URL('./client/dist', import.meta.url)),
    logger: context.logger,
  });
}
