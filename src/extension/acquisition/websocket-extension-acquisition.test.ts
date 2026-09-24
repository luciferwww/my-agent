import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { acquireExtensions } from './loader.js';

const EXTENSIONS_DIR = fileURLToPath(new URL('../../../extensions/', import.meta.url));

describe('WebSocket Extension acquisition', () => {
  it('applies Descriptor defaults only after an explicit entry enables the Extension', async () => {
    const absent = await acquireExtensions({
      extensionsDir: EXTENSIONS_DIR,
      extensionsConfig: {
        enabled: true,
        entries: {},
      },
      environment: {},
    });
    expect(absent.loadedUnits).toEqual([]);

    const enabled = await acquireExtensions({
      extensionsDir: EXTENSIONS_DIR,
      extensionsConfig: {
        enabled: true,
        entries: {
          'websocket-channel': {},
        },
      },
      environment: {},
    });

    expect(enabled.loadedUnits).toHaveLength(1);
    expect(enabled.loadedUnits[0]).toMatchObject({
      unitId: 'websocket-channel',
      source: 'external',
      required: false,
      initiallyEnabled: true,
    });
    expect(enabled.diagnostics.filter((diagnostic) =>
      diagnostic.extensionId === 'websocket-channel')).toEqual([]);

    const instance = await enabled.loadedUnits[0]!.create(new AbortController().signal);
    let createChannel: (() => unknown) | undefined;
    instance.registration.register({
      registerProvider: () => undefined,
      registerTool: () => undefined,
      registerHook: () => undefined,
      registerChannel: (contribution) => {
        createChannel = contribution.create;
      },
    });
    const channel = createChannel?.() as {
      readonly options?: {
        readonly config?: Readonly<Record<string, unknown>>;
      };
    };
    expect(channel.options?.config).toEqual({
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/ws',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    });

  });

  it('isolates schema and semantic configuration failures', async () => {
    const schemaFailure = await acquireExtensions({
      extensionsDir: EXTENSIONS_DIR,
      extensionsConfig: {
        enabled: true,
        entries: {
          'websocket-channel': {
            config: { unknown: true },
          },
        },
      },
      environment: {},
    });
    expect(schemaFailure.loadedUnits).toEqual([]);
    expect(schemaFailure.diagnostics).toContainEqual(expect.objectContaining({
      extensionId: 'websocket-channel',
      code: 'config_validation_failed',
    }));

    const unsafePathFailure = await acquireExtensions({
      extensionsDir: EXTENSIONS_DIR,
      extensionsConfig: {
        enabled: true,
        entries: {
          'websocket-channel': {
            config: { webSocketPath: '/</script>' },
          },
        },
      },
      environment: {},
    });
    expect(unsafePathFailure.loadedUnits).toEqual([]);
    expect(unsafePathFailure.diagnostics).toContainEqual(expect.objectContaining({
      extensionId: 'websocket-channel',
      code: 'config_validation_failed',
    }));

    const semanticFailure = await acquireExtensions({
      extensionsDir: EXTENSIONS_DIR,
      extensionsConfig: {
        enabled: true,
        entries: {
          'websocket-channel': {
            config: {
              webSocketPath: '/',
              clientPath: '/',
            },
          },
        },
      },
      environment: {},
    });
    expect(semanticFailure.loadedUnits).toEqual([]);
    expect(semanticFailure.diagnostics).toContainEqual(expect.objectContaining({
      extensionId: 'websocket-channel',
      code: 'factory_failed',
    }));
  });
});
