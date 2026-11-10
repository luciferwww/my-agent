import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelCatalogSnapshot, ProviderCatalogEntry } from '../../core/channel/index.js';
import { RuntimeApp } from '../../runtime/RuntimeApp.js';
import { runStandaloneHost } from '../../hosts/standalone/standalone-host.js';
import { acquireExtensions } from './loader.js';
import type { ResolvedHostExtensionsConfig } from './types.js';

const FIXTURE_ROOT = fileURLToPath(new URL(
  '../../../test-fixtures/extension-acquisition/',
  import.meta.url,
));
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

describe('Extension acquisition to Runtime integration', () => {
  let root: string;
  let extensionsDir: string;
  let agentHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'my-agent-acquisition-runtime-'));
    extensionsDir = join(root, 'installation', 'extensions');
    agentHome = join(root, 'agent-home');
    await mkdir(agentHome);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts a new Home, loads an unconfigured WebSocket despite a bad neighbor and saves its first LLM settings', async () => {
    const freshHome = join(root, 'fresh-home');
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback address.');
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    const packageDir = join(extensionsDir, 'websocket-channel');
    await mkdir(packageDir, { recursive: true });
    const descriptor = JSON.parse(await readFile(
      new URL('../../../extensions/websocket-channel/extension.json', import.meta.url), 'utf8',
    ));
    descriptor.entry = 'entry.js';
    descriptor.configSchema.properties.port.default = port;
    await writeFile(join(packageDir, 'extension.json'), JSON.stringify(descriptor));
    await writeFile(join(packageDir, 'entry.js'),
      `export { createExtension } from ${JSON.stringify(new URL('../../../extensions/websocket-channel/entry.ts', import.meta.url).href)};\n`);
    await installFixture(extensionsDir, 'bad-neighbor', 'bad-neighbor', 'invalid-export.js');

    await runStandaloneHost({
      argv: [], env: {},
      resolvePathContext: async () => ({ installDir: join(root, 'installation'), agentHome: freshHome }),
      createRuntime: async (options) => RuntimeApp.create({
        ...options,
        cliOverrides: { memory: { enabled: false } },
        dependencies: {
          createMemoryManager: async () => null,
          acquireExtensions: async (options) => {
            const result = await acquireExtensions(options);
            expect(result.diagnostics).toEqual([
              expect.objectContaining({ extensionId: 'bad-neighbor', code: 'entry_export_invalid' }),
            ]);
            return result;
          },
        },
        onEvent: (event) => {
          if (event.type === 'app_ready') expect(event.channelIds).toContain('websocket');
        },
      }),
      createHost: (runtime) => ({
        dispose: () => undefined,
        shutdown: (reason) => runtime.close(reason),
        completion: (async () => {
          const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          try {
            await once(client, 'open');
            const request = async (value: unknown) => {
              const received = once(client, 'message');
              client.send(JSON.stringify(value));
              const [data] = await received;
              return JSON.parse(data.toString());
            };
            expect(await request({ type: 'hello', clientId: 'fresh-home' })).toMatchObject({ type: 'hello_ack' });
            expect(await readFile(join(freshHome, 'config.json'), 'utf8')).toBe('{}\n');
            const loaded = await request({ type: 'settings_action', requestId: 'load', action: 'load', input: {} });
            expect(loaded).toMatchObject({
              ok: true, output: {
                modelCatalog: { providers: [] },
                diagnostics: expect.arrayContaining([expect.objectContaining({ extensionId: 'bad-neighbor', code: 'entry_export_invalid' })]),
              },
            });
            const llm = loaded.output.sections.find((section: { id: string }) => section.id === 'llm');
            const settings = {
              builtin: { baseURL: 'http://127.0.0.1:9', models: [{ modelId: 'first', protocol: 'openai-responses' }] },
              defaultModel: { providerId: 'builtin', modelId: 'first' },
            };
            expect(await request({
              type: 'settings_action', requestId: 'save', action: 'update',
              input: { sectionId: 'llm', expectedRevision: llm.revision, settings },
            })).toMatchObject({ ok: true, output: { modelCatalog: { providers: [
              expect.objectContaining({ providerId: 'builtin', configurationSectionId: 'llm' }),
            ] } } });
            expect(JSON.parse(await readFile(join(freshHome, 'config.json'), 'utf8'))).toEqual({ llm: settings });
          } finally {
            client.terminate();
            await runtime.close('fresh Home validation complete');
          }
          return runtime.close('fresh Home validation complete');
        })(),
      }),
    });
  }, 15_000);

  it('publishes an acquired fixture Provider through the authoritative Runtime projection', async () => {
    await installFixture(
      extensionsDir,
      'renamed-runtime-provider',
      'fixture-runtime-provider',
      'runtime-provider.js',
    );
    await installFixture(extensionsDir, 'bad-neighbor', 'invalid-export', 'invalid-export.js');
    const installationBefore = await snapshotTree(join(root, 'installation'));

    const acquisition = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig({}),
      environment: {},
    });

    expect(acquisition.loadedUnits.map(({ unitId }) => unitId))
      .toEqual(['fixture-runtime-provider']);
    expect(acquisition.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: 'invalid-export',
        code: 'entry_export_invalid',
      }),
    ]);

    const runtime = await RuntimeApp.create({
      agentHome,
      loadedUnits: acquisition.loadedUnits,
      cliOverrides: {
        memory: { enabled: false },
        tools: { deny: ['task'] },
      },
    });
    try {
      const catalog: ModelCatalogSnapshot = runtime.application.getModelCatalog();
      expect(catalog.providers).toContainEqual({
        providerId: 'fixture-provider',
        displayName: 'Fixture Provider',
        models: [{ modelId: 'fixture-model', displayName: 'Fixture Model' }],
      });
      const fixtureProvider: ProviderCatalogEntry | undefined = catalog.providers.find(
        ({ providerId }) => providerId === 'fixture-provider',
      );
      expect(Object.isFrozen(catalog)).toBe(true);
      expect(Object.isFrozen(catalog.defaultSelection)).toBe(true);
      expect(Object.isFrozen(catalog.providers)).toBe(true);
      expect(Object.isFrozen(fixtureProvider)).toBe(true);
      expect(Object.isFrozen(fixtureProvider?.models)).toBe(true);
      expect(Object.isFrozen(fixtureProvider?.models[0])).toBe(true);
    } finally {
      await runtime.close('acquisition Runtime integration complete');
    }
    expect(await snapshotTree(join(root, 'installation'))).toEqual(installationBefore);
  });

  it('does not publish an installed fixture when its Host entry is disabled', async () => {
    await installFixture(
      extensionsDir,
      'runtime-provider',
      'fixture-runtime-provider',
      'runtime-provider.js',
    );

    const acquisition = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig({
        'fixture-runtime-provider': { enabled: false },
      }),
      environment: {},
    });

    expect(acquisition.loadedUnits).toEqual([]);
    expect(acquisition.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: 'fixture-runtime-provider',
        code: 'extension_disabled',
      }),
    ]);

    const runtime = await RuntimeApp.create({
      agentHome,
      loadedUnits: acquisition.loadedUnits,
      cliOverrides: {
        memory: { enabled: false },
        tools: { deny: ['task'] },
      },
    });
    try {
      const catalog = runtime.application.getModelCatalog();
      expect(catalog.providers.map(({ providerId }) => providerId))
        .not.toContain('fixture-provider');
      expect(catalog.providers).toEqual([]);
      expect(catalog.defaultSelection).toEqual({ state: 'unset' });
    } finally {
      await runtime.close('disabled acquisition Runtime integration complete');
    }
  });
});

function hostConfig(entries: Record<string, unknown>): ResolvedHostExtensionsConfig {
  return Object.freeze({ entries: Object.freeze(entries) });
}

async function installFixture(
  extensionsDir: string,
  locator: string,
  extensionId: string,
  fixtureFile: string,
): Promise<void> {
  const installationRoot = join(extensionsDir, locator);
  await mkdir(installationRoot, { recursive: true });
  await Promise.all([
    copyFile(join(FIXTURE_ROOT, fixtureFile), join(installationRoot, 'entry.js')),
    writeFile(join(installationRoot, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(installationRoot, 'extension.json'), `${JSON.stringify({
      manifestVersion: 1,
      id: extensionId,
      version: '1.0.0',
      entry: 'entry.js',
      configSchema: {
        $schema: DRAFT_07,
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    }, null, 2)}\n`),
  ]);
}

async function snapshotTree(root: string, relativeDir = ''): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const currentDir = join(root, relativeDir);
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotTree(root, relativePath));
    } else if (entry.isFile()) {
      snapshot[relativePath] = await readFile(join(root, relativePath), 'base64');
    }
  }
  return snapshot;
}
