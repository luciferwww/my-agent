import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import type {
  ExtensionLoadContext,
  ExtensionLogger,
  ExtensionRegistrationApi,
} from 'my-agent/extension-api';

import { createExtension } from './entry.js';

describe('WebSocket Extension entry', () => {
  it('returns an uncreated external Unit and registers the WebSocket Channel', async () => {
    const logger: ExtensionLogger = Object.freeze({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const context: ExtensionLoadContext = Object.freeze({
      config: Object.freeze({
        host: '127.0.0.1',
        port: 0,
        webSocketPath: '/ws',
        clientPath: '/',
        approval: true,
        openBrowser: false,
      }),
      logger,
    });

    const unit = createExtension(context);

    expect(unit).toMatchObject({
      unitId: 'websocket-channel',
      source: 'external',
      orderKey: 'websocket-channel',
      required: false,
      initiallyEnabled: true,
      dependencies: [],
    });
    const instance = await unit.create(new AbortController().signal);
    const registerChannel = vi.fn();
    instance.registration.register({
      registerProvider: vi.fn(),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      registerChannel,
    } satisfies ExtensionRegistrationApi);
    expect(registerChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'websocket',
      create: expect.any(Function),
    }));
    expect(fileURLToPath(new URL('./client/chat.html', import.meta.url))).toContain(
      'extensions',
    );
  });
});
