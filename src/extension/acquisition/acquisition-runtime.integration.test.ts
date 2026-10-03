import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelCatalogSnapshot, ProviderCatalogEntry } from '../../core/channel/index.js';
import { RuntimeApp } from '../../runtime/RuntimeApp.js';
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
      extensionsConfig: hostConfig({
        'fixture-runtime-provider': { enabled: true },
        'invalid-export': { enabled: true },
      }),
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
        subagents: { enabled: false, maxDepth: 1 },
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
        subagents: { enabled: false, maxDepth: 1 },
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
  return Object.freeze({ enabled: true, entries: Object.freeze(entries) });
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
