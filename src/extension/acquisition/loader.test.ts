import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../platform/logger/index.js';
import { discoverExtensionDescriptors } from './discovery.js';
import { acquireExtensions, loadExtensionCandidate } from './loader.js';
import type { ResolvedHostExtensionsConfig } from './types.js';

const FIXTURE_ROOT = fileURLToPath(new URL(
  '../../../test-fixtures/extension-acquisition/',
  import.meta.url,
));
const EXECUTION_MARKER = Symbol.for('my-agent.test.extension-acquisition.executions');
const IMPORT_MARKER = Symbol.for('my-agent.test.extension-acquisition.imported');
const CONTEXT_MARKER = Symbol.for('my-agent.test.extension-acquisition.factory-context');
const UNIT_CREATE_MARKER = Symbol.for('my-agent.test.extension-acquisition.unit-create');
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

describe('acquireExtensions', () => {
  let installDir: string;
  let extensionsDir: string;

  beforeEach(async () => {
    installDir = await mkdtemp(join(tmpdir(), 'my-agent-loader-'));
    extensionsDir = join(installDir, 'extensions');
    clearMarkers();
  });

  afterEach(async () => {
    clearMarkers();
    await rm(installDir, { recursive: true, force: true });
  });

  it('returns immediately when the global kill switch is disabled', async () => {
    await writeFile(extensionsDir, 'discovery must not run');

    const result = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig(false, {}),
      environment: {},
    });

    expect(result).toEqual({ loadedUnits: [], diagnostics: [] });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('keeps missing and explicitly disabled entries structured without execution', async () => {
    await installFixture(extensionsDir, 'missing-config', 'missing-config', 'never-execute.js');
    await installFixture(extensionsDir, 'disabled', 'disabled', 'never-execute.js');

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, { disabled: { enabled: false } }),
      environment: {},
    });

    expect(result.loadedUnits).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'disabled',
        code: 'extension_disabled',
        extensionId: 'disabled',
      }),
      expect.objectContaining({
        category: 'disabled',
        code: 'extension_disabled',
        extensionId: 'missing-config',
      }),
    ]);
    expect(marker(EXECUTION_MARKER)).toBeUndefined();
  });

  it('defaults a configured Extension entry to enabled', async () => {
    const info = vi.spyOn(Logger.get('ExtensionAcquisition'), 'info');
    await installFixture(extensionsDir, 'valid', 'fixture-valid', 'valid-unit.js');

    const result = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig(true, { 'fixture-valid': {} }),
      environment: {},
    });

    expect(result.loadedUnits.map((unit) => unit.unitId)).toEqual(['fixture-valid']);
    expect(result.diagnostics).toEqual([]);
    expect(info.mock.calls).toEqual([
      ['extension acquisition started', { root: extensionsDir }],
      ['extension acquisition completed', {
        loadedCount: 1,
        extensionIds: ['fixture-valid'],
      }],
    ]);
  });

  it('rejects malformed enabled entry configuration before import', async () => {
    await installFixture(extensionsDir, 'malformed', 'malformed', 'never-execute.js');

    const result = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig(true, { malformed: { enabled: true, unknown: true } }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'config_invalid',
        code: 'entry_config_invalid',
        extensionId: 'malformed',
      }),
    ]);
    expect(marker(EXECUTION_MARKER)).toBeUndefined();
  });

  it('isolates missing environment values and secrets before import', async () => {
    await installFixture(extensionsDir, 'missing-value', 'missing-value', 'never-execute.js',
      objectSchema({ endpoint: { type: 'string' } }, ['endpoint']));
    await installFixture(extensionsDir, 'missing-secret', 'missing-secret', 'never-execute.js',
      objectSchema({ token: { type: 'string' } }, ['token']));

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, {
        'missing-value': {
          enabled: true,
          config: { endpoint: { $env: 'MISSING_URL' } },
        },
        'missing-secret': {
          enabled: true,
          config: { token: { $secret: { source: 'env', name: 'MISSING_TOKEN' } } },
        },
      }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'secret_unavailable',
        code: 'environment_secret_unavailable',
        extensionId: 'missing-secret',
        referencePath: '/token',
        environmentVariable: 'MISSING_TOKEN',
      }),
      expect.objectContaining({
        category: 'config_invalid',
        code: 'environment_value_unavailable',
        extensionId: 'missing-value',
        referencePath: '/endpoint',
        environmentVariable: 'MISSING_URL',
      }),
    ]);
    expect(marker(EXECUTION_MARKER)).toBeUndefined();
  });

  it('rejects strict Schema compilation and input validation before import', async () => {
    await installFixture(extensionsDir, 'bad-schema', 'bad-schema', 'never-execute.js', {
      ...objectSchema({}),
      unknownKeyword: true,
    });
    await installFixture(extensionsDir, 'bad-input', 'bad-input', 'never-execute.js',
      objectSchema({ count: { type: 'integer' } }, ['count']));

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, {
        'bad-schema': { enabled: true },
        'bad-input': { enabled: true, config: { count: '2' } },
      }),
      environment: {},
    });

    expect(result.diagnostics.map((diagnostic) => [diagnostic.extensionId, diagnostic.code]))
      .toEqual([
        ['bad-input', 'config_validation_failed'],
        ['bad-schema', 'config_schema_invalid'],
      ]);
    expect(marker(EXECUTION_MARKER)).toBeUndefined();
  });

  it('loads a valid factory with only frozen scoped config and normalizes Unit ordering', async () => {
    await installFixture(extensionsDir, 'renamed-directory', 'fixture-valid', 'valid-unit.js',
      objectSchema({
        endpoint: { type: 'string' },
        retries: { type: 'integer', default: 2 },
      }, ['endpoint']));

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, {
        'fixture-valid': {
          enabled: true,
          config: { endpoint: { $env: 'SERVICE_URL' } },
        },
      }),
      environment: { SERVICE_URL: 'https://relay.invalid' },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.loadedUnits).toHaveLength(1);
    expect(result.loadedUnits[0]).toMatchObject({
      unitId: 'fixture-valid',
      source: 'external',
      orderKey: 'fixture-valid',
      required: false,
      initiallyEnabled: true,
      dependencies: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.loadedUnits)).toBe(true);
    expect(Object.isFrozen(result.loadedUnits[0])).toBe(true);
    expect(marker(UNIT_CREATE_MARKER)).toBeUndefined();

    const context = marker(CONTEXT_MARKER) as { readonly config: Record<string, unknown> };
    expect(Object.keys(context)).toEqual(['config']);
    expect(context.config).toEqual({ endpoint: 'https://relay.invalid', retries: 2 });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.config)).toBe(true);
  });

  it('loads a TypeScript entry through Jiti', async () => {
    await installSource(
      extensionsDir,
      'typescript-entry',
      'typescript-entry',
      [
        "import { createLoadedRuntimeUnit } from 'my-agent/extension-api';",
        'export function createExtension(): unknown {',
        '  return createLoadedRuntimeUnit({',
        "    registration: { id: 'typescript-entry', source: 'external', register() {} },",
        '    required: false,',
        '  });',
        '}',
      ].join('\n'),
      'entry.ts',
    );

    const result = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig(true, { 'typescript-entry': {} }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.loadedUnits.map((unit) => unit.unitId)).toEqual(['typescript-entry']);
  });

  it('loads a built JavaScript entry through Jiti', async () => {
    await installSource(
      extensionsDir,
      'javascript-entry',
      'javascript-entry',
      [
        "import { createLoadedRuntimeUnit } from 'my-agent/extension-api';",
        'export function createExtension() {',
        '  return createLoadedRuntimeUnit({',
        "    registration: { id: 'javascript-entry', source: 'external', register() {} },",
        '    required: false,',
        '  });',
        '}',
      ].join('\n'),
    );

    const result = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig(true, { 'javascript-entry': {} }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.loadedUnits.map((unit) => unit.unitId)).toEqual(['javascript-entry']);
  });

  it('resolves a dependency from the Extension package', async () => {
    const installationName = 'package-dependency';
    const candidatePath = join(extensionsDir, installationName);
    const dependencyPath = join(candidatePath, 'node_modules', 'fixture-extension-dependency');
    await installSource(
      extensionsDir,
      installationName,
      'package-dependency',
      [
        "import { extensionId } from 'fixture-extension-dependency';",
        `export function createExtension() { return ${unitSourceExpression('extensionId')}; }`,
      ].join('\n'),
      'entry.ts',
    );
    await writeFile(join(candidatePath, 'package.json'), JSON.stringify({
      type: 'module',
      dependencies: { 'fixture-extension-dependency': '1.0.0' },
    }));
    await mkdir(dependencyPath, { recursive: true });
    await writeFile(join(dependencyPath, 'package.json'), JSON.stringify({
      name: 'fixture-extension-dependency',
      type: 'module',
      exports: './index.js',
    }));
    await writeFile(join(dependencyPath, 'index.js'), "export const extensionId = 'package-dependency';\n");

    const result = await acquireExtensions({
      extensionsDir,
      extensionsConfig: hostConfig(true, { 'package-dependency': {} }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.loadedUnits.map((unit) => unit.unitId)).toEqual(['package-dependency']);
  });

  it('does not retain factory errors or materialized secrets', async () => {
    const secret = 'sentinel-secret-value';
    const warn = vi.spyOn(Logger.get('ExtensionAcquisition'), 'warn');
    await installFixture(extensionsDir, 'factory-throws', 'factory-throws', 'factory-throws.js',
      objectSchema({ secret: { type: 'string' } }, ['secret']));

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, {
        'factory-throws': {
          enabled: true,
          config: { secret: { $secret: { source: 'env', name: 'FACTORY_SECRET' } } },
        },
      }),
      environment: { FACTORY_SECRET: secret },
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'extension_config_rejected',
        code: 'factory_failed',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('Extension rejected');
    expect(warn).toHaveBeenCalledWith('extension acquisition warning', expect.objectContaining({
      category: 'extension_config_rejected',
      code: 'factory_failed',
      extensionId: 'factory-throws',
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it('distinguishes import, export, and Unit metadata failures', async () => {
    await installSource(extensionsDir, 'syntax-error', 'syntax-error', 'export function broken( {');
    await installFixture(extensionsDir, 'invalid-export', 'invalid-export', 'invalid-export.js');
    await installSource(
      extensionsDir,
      'extra-export',
      'extra-export',
      `${unitSource('extra-export', {})}\nexport const extra = true;`,
    );
    await installFixture(extensionsDir, 'metadata-mismatch', 'metadata-mismatch', 'metadata-mismatch.js');

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, {
        'syntax-error': { enabled: true },
        'invalid-export': { enabled: true },
        'extra-export': { enabled: true },
        'metadata-mismatch': { enabled: true },
      }),
      environment: {},
    });

    expect(result.diagnostics.map((diagnostic) => [diagnostic.extensionId, diagnostic.code]))
      .toEqual([
        ['extra-export', 'entry_export_invalid'],
        ['invalid-export', 'entry_export_invalid'],
        ['metadata-mismatch', 'unit_metadata_invalid'],
        ['syntax-error', 'entry_import_failed'],
      ]);
    expect(marker(IMPORT_MARKER)).toBe(true);
  });

  it('rejects an asynchronous entry factory as invalid Unit output', async () => {
    await installSource(
      extensionsDir,
      'async-factory',
      'async-factory',
      'export async function createExtension() { return {}; }',
    );

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, { 'async-factory': { enabled: true } }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'unit_invalid',
        code: 'unit_metadata_invalid',
        extensionId: 'async-factory',
      }),
    ]);
  });

  it.each([
    ['wrong source', { source: 'builtin' }],
    ['required Unit', { required: true }],
    ['disabled Unit', { initiallyEnabled: false }],
    ['Unit dependency', { dependencies: ['other'] }],
    ['missing create', { create: null }],
  ])('rejects %s metadata', async (_label, override) => {
    const source = unitSource('metadata-case', override);
    await installSource(extensionsDir, 'metadata-case', 'metadata-case', source);

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, { 'metadata-case': { enabled: true } }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'unit_metadata_invalid' }),
    ]);
  });

  it('keeps duplicate identity diagnostics without adding stale configuration', async () => {
    await installFixture(extensionsDir, 'duplicate-a', 'duplicate', 'never-execute.js');
    await installFixture(extensionsDir, 'duplicate-b', 'duplicate', 'never-execute.js');

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, { duplicate: { enabled: true } }),
      environment: {},
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'duplicate_identity',
      'duplicate_identity',
    ]);
    expect(marker(EXECUTION_MARKER)).toBeUndefined();
  });

  it('reports stale configured IDs without executing any entry', async () => {
    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, { stale: { enabled: true } }),
      environment: {},
    });

    expect(result.diagnostics).toEqual([{
      category: 'config_invalid',
      code: 'stale_configured_id',
      extensionId: 'stale',
    }]);
  });

  it('isolates a bad candidate while retaining a valid Unit', async () => {
    await installFixture(extensionsDir, 'valid', 'fixture-valid', 'valid-unit.js');
    await installFixture(extensionsDir, 'bad', 'invalid-export', 'invalid-export.js');

    const result = await acquireExtensions({
      extensionsDir: extensionsDir,
      extensionsConfig: hostConfig(true, {
        'fixture-valid': { enabled: true },
        'invalid-export': { enabled: true },
      }),
      environment: {},
    });

    expect(result.loadedUnits.map((unit) => unit.unitId)).toEqual(['fixture-valid']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: 'invalid-export',
        code: 'entry_export_invalid',
      }),
    ]);
  });

  it('revalidates the entry immediately before import', async () => {
    await installFixture(extensionsDir, 'replace-entry', 'replace-entry', 'never-execute.js');
    const discovery = await discoverExtensionDescriptors(extensionsDir);
    const candidate = discovery.candidates[0]!;
    await rm(candidate.entryPath);
    await mkdir(candidate.entryPath);

    const result = await loadExtensionCandidate(
      candidate,
      extensionsDir,
      hostConfig(true, { 'replace-entry': { enabled: true } }),
      {},
    );

    expect(result).toEqual({
      diagnostic: expect.objectContaining({
        category: 'entry_load_failed',
        code: 'entry_revalidation_failed',
      }),
    });
    expect(marker(EXECUTION_MARKER)).toBeUndefined();
  });
});

function hostConfig(
  enabled: boolean,
  entries: Record<string, unknown>,
): ResolvedHostExtensionsConfig {
  return Object.freeze({ enabled, entries: Object.freeze(entries) });
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    $schema: DRAFT_07,
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

async function installFixture(
  home: string,
  installationName: string,
  extensionId: string,
  fixtureName: string,
  schema: Record<string, unknown> = objectSchema({}),
): Promise<void> {
  const candidatePath = join(home, installationName);
  await mkdir(candidatePath, { recursive: true });
  await Promise.all([
    copyFile(join(FIXTURE_ROOT, fixtureName), join(candidatePath, 'entry.js')),
    copyFile(join(FIXTURE_ROOT, 'package.json'), join(candidatePath, 'package.json')),
  ]);
  await writeFile(join(candidatePath, 'extension.json'), JSON.stringify({
    manifestVersion: 1,
    id: extensionId,
    version: '1.0.0',
    entry: 'entry.js',
    configSchema: schema,
  }));
}

async function installSource(
  home: string,
  installationName: string,
  extensionId: string,
  source: string,
  entry = 'entry.js',
): Promise<void> {
  const candidatePath = join(home, installationName);
  await mkdir(candidatePath, { recursive: true });
  await writeFile(join(candidatePath, 'package.json'), '{"type":"module"}');
  await writeFile(join(candidatePath, entry), source);
  await writeFile(join(candidatePath, 'extension.json'), JSON.stringify({
    manifestVersion: 1,
    id: extensionId,
    version: '1.0.0',
    entry,
    configSchema: objectSchema({}),
  }));
}

function unitSource(extensionId: string, override: Record<string, unknown>): string {
  const metadata = {
    unitId: extensionId,
    source: 'external',
    orderKey: 'extension-order',
    required: false,
    initiallyEnabled: true,
    dependencies: [],
    create: '__FUNCTION__',
    ...override,
  };
  const fields = Object.entries(metadata).map(([key, value]) => {
    const rendered = value === '__FUNCTION__'
      ? '() => { throw new Error("Runtime owns Unit creation."); }'
      : JSON.stringify(value);
    return `${JSON.stringify(key)}: ${rendered}`;
  });
  return `export function createExtension() { return { ${fields.join(', ')} }; }`;
}

function unitSourceExpression(extensionIdExpression: string): string {
  return `{ unitId: ${extensionIdExpression}, source: 'external', orderKey: ${extensionIdExpression}, required: false, initiallyEnabled: true, dependencies: [], create() {} }`;
}

function marker(key: symbol): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[key];
}

function clearMarkers(): void {
  for (const key of [EXECUTION_MARKER, IMPORT_MARKER, CONTEXT_MARKER, UNIT_CREATE_MARKER]) {
    delete (globalThis as Record<PropertyKey, unknown>)[key];
  }
}