import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverExtensionDescriptors } from './discovery.js';
import { readHostExtensionsConfig } from './host-config.js';

const EXECUTION_MARKER = Symbol.for('my-agent.test.extension-acquisition.executions');
const FIXTURE_ENTRY = fileURLToPath(new URL(
  '../../test-fixtures/extension-acquisition/never-execute.js',
  import.meta.url,
));
const VALID_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
});

describe('discoverExtensionDescriptors', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'my-agent-discovery-'));
    delete (globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER];
  });

  afterEach(async () => {
    delete (globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER];
    await rm(agentHome, { recursive: true, force: true });
  });

  it('returns an empty frozen result when the discovery root is missing', async () => {
    const result = await discoverExtensionDescriptors(agentHome);

    expect(result).toEqual({ candidates: [], diagnostics: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it('discovers direct children and orders candidates by Descriptor ID', async () => {
    await installCandidate(agentHome, 'first-created', descriptor('zeta'));
    await installCandidate(agentHome, 'renamed-locator', descriptor('alpha'));
    await mkdir(join(agentHome, 'extensions', 'container', 'nested'), { recursive: true });
    await writeFile(join(agentHome, 'extensions', 'ordinary-file'), 'ignored');

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.candidates.map((candidate) => candidate.descriptor.id)).toEqual(['alpha', 'zeta']);
    expect(basename(result.candidates[0]!.installationPath)).toBe('renamed-locator');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'descriptor_missing', locator: '"container"' }),
    ]);
    expect(Object.isFrozen(result.candidates[0]!.descriptor.configSchema)).toBe(true);
  });

  it('isolates every candidate sharing a Descriptor ID with no winner', async () => {
    await installCandidate(agentHome, 'duplicate-b', descriptor('shared'));
    await installCandidate(agentHome, 'duplicate-a', descriptor('shared'));
    await installCandidate(agentHome, 'unique', descriptor('unique'));

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.candidates.map((candidate) => candidate.descriptor.id)).toEqual(['unique']);
    expect(result.diagnostics).toEqual([
      {
        category: 'duplicate_identity',
        code: 'duplicate_identity',
        extensionId: 'shared',
        locator: '"duplicate-a"',
      },
      {
        category: 'duplicate_identity',
        code: 'duplicate_identity',
        extensionId: 'shared',
        locator: '"duplicate-b"',
      },
    ]);
    expect((globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER]).toBeUndefined();
  });

  it.each([
    ['invalid identity', { id: 'invalid/id' }, 'descriptor_invalid'],
    ['empty version', { version: '' }, 'descriptor_invalid'],
    ['wrong manifest version', { manifestVersion: 2 }, 'descriptor_invalid'],
    ['absolute entry', {
      entry: process.platform === 'win32' ? 'C:\\outside\\entry.js' : '/outside/entry.js',
    }, 'descriptor_invalid'],
    ['parent entry', { entry: '../entry.js' }, 'descriptor_invalid'],
    ['non-JavaScript entry', { entry: 'entry.mjs' }, 'descriptor_invalid'],
    ['external Schema reference', {
      configSchema: {
        ...VALID_SCHEMA,
        properties: { value: { $ref: 'https://example.invalid/schema.json' } },
      },
    }, 'descriptor_invalid'],
    ['unresolved internal Schema reference', {
      configSchema: {
        ...VALID_SCHEMA,
        properties: { value: { $ref: '#/definitions/missing' } },
      },
    }, 'descriptor_invalid'],
    ['invalid Schema root', {
      configSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        additionalProperties: false,
      },
    }, 'descriptor_invalid'],
  ])('diagnoses %s before entry execution', async (_label, overrides, expectedCode) => {
    await installCandidate(agentHome, 'invalid', descriptor('invalid-candidate', overrides));

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: expectedCode, locator: '"invalid"' }),
    ]);
    expect((globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER]).toBeUndefined();
  });

  it('diagnoses malformed and missing descriptors independently', async () => {
    const root = join(agentHome, 'extensions');
    await mkdir(join(root, 'malformed'), { recursive: true });
    await writeFile(join(root, 'malformed', 'extension.json'), '{ invalid');
    await mkdir(join(root, 'missing'), { recursive: true });

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'descriptor_invalid_json',
      'descriptor_missing',
    ]);
  });

  it('accepts a resolvable Descriptor-internal Schema reference during A1 preflight', async () => {
    await installCandidate(agentHome, 'internal-ref', descriptor('internal-ref', {
      configSchema: {
        ...VALID_SCHEMA,
        definitions: { text: { type: 'string' } },
        properties: { value: { $ref: '#/definitions/text' } },
      },
    }));

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.candidates.map((candidate) => candidate.descriptor.id)).toEqual(['internal-ref']);
  });

  it('rejects a descriptor path that is not a regular file without execution', async () => {
    const candidatePath = join(agentHome, 'extensions', 'descriptor-directory');
    await mkdir(join(candidatePath, 'extension.json'), { recursive: true });
    await copyFile(FIXTURE_ENTRY, join(candidatePath, 'entry.js'));

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'descriptor_unreadable' }),
    ]);
    expect((globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER]).toBeUndefined();
  });

  it('rejects a candidate directory reparse point', async () => {
    const outside = join(agentHome, 'outside-candidate');
    await installCandidateAt(outside, descriptor('outside'));
    const root = join(agentHome, 'extensions');
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'candidate_reparse_point', locator: '"linked"' }),
    ]);
  });

  it('rejects an entry reparse point before execution', async (context) => {
    const candidatePath = join(agentHome, 'extensions', 'linked-entry');
    const outsideEntry = join(agentHome, 'outside-entry.js');
    await mkdir(candidatePath, { recursive: true });
    await copyFile(FIXTURE_ENTRY, outsideEntry);
    await writeFile(
      join(candidatePath, 'extension.json'),
      JSON.stringify(descriptor('linked-entry')),
    );
    try {
      await symlink(outsideEntry, join(candidatePath, 'entry.js'), 'file');
    } catch (error) {
      if (hasErrorCode(error, 'EPERM')) {
        context.skip();
        return;
      }
      throw error;
    }

    const result = await discoverExtensionDescriptors(agentHome);

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'entry_reparse_point',
        extensionId: 'linked-entry',
      }),
    ]);
    expect((globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER]).toBeUndefined();
  });

  it('does not execute statically rejected or disabled fixture entries', async () => {
    await installCandidate(agentHome, 'rejected', descriptor('bad/id'));
    await installCandidate(agentHome, 'disabled', descriptor('disabled'));
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({
      extensions: {
        entries: {
          disabled: { enabled: false },
        },
      },
    }));

    const [config] = await Promise.all([
      readHostExtensionsConfig(agentHome),
      discoverExtensionDescriptors(agentHome),
    ]);

    expect(config.entries['disabled']).toEqual({ enabled: false });
    expect((globalThis as Record<PropertyKey, unknown>)[EXECUTION_MARKER]).toBeUndefined();
  });

  it('fails when an existing discovery root is not a readable directory', async () => {
    await writeFile(join(agentHome, 'extensions'), 'not-a-directory');

    await expect(discoverExtensionDescriptors(agentHome))
      .rejects.toMatchObject({
        code: 'DISCOVERY_ROOT_INVALID',
      });
  });

  it('fails when the discovery root canonical path escapes Agent Home', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'my-agent-outside-extensions-'));
    try {
      await symlink(
        outsideRoot,
        join(agentHome, 'extensions'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await expect(discoverExtensionDescriptors(agentHome)).rejects.toMatchObject({
        code: 'DISCOVERY_ROOT_INVALID',
      });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('keeps a long non-BMP diagnostic locator bounded and validly escaped', async () => {
    const installationName = `invalid-${'😀'.repeat(100)}`;
    await mkdir(join(agentHome, 'extensions', installationName), { recursive: true });

    const result = await discoverExtensionDescriptors(agentHome);
    const locator = result.diagnostics[0]!.locator;

    expect(locator.length).toBeLessThanOrEqual(200);
    expect(() => JSON.parse(locator)).not.toThrow();
    expect(JSON.parse(locator)).toMatch(/\.\.\.$/);
  });
});

function descriptor(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    entry: 'entry.js',
    configSchema: { ...VALID_SCHEMA },
    ...overrides,
  };
}

async function installCandidate(
  home: string,
  installationName: string,
  descriptorValue: Record<string, unknown>,
): Promise<void> {
  await installCandidateAt(join(home, 'extensions', installationName), descriptorValue);
}

async function installCandidateAt(
  candidatePath: string,
  descriptorValue: Record<string, unknown>,
): Promise<void> {
  await mkdir(candidatePath, { recursive: true });
  await copyFile(FIXTURE_ENTRY, join(candidatePath, 'entry.js'));
  await writeFile(join(candidatePath, 'extension.json'), JSON.stringify(descriptorValue));
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}