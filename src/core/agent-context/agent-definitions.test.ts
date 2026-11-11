import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { ensureAgentContext } from './init.js';
import { loadAgentDefinitions } from './agent-definitions.js';
import { prepareContextFiles } from './loader.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

describe('startup Agent definitions', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-definitions-'));
    await mkdir(join(home, 'agents'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function define(id: string, identity?: string): Promise<string> {
    const dir = join(home, 'agents', id);
    await mkdir(dir, { recursive: true });
    if (identity !== undefined) await writeFile(join(dir, 'IDENTITY.md'), identity);
    return dir;
  }

  it('loads the shipped definitions without requiring model configuration', async () => {
    await rm(join(home, 'agents'), { recursive: true });
    await ensureAgentContext(home);
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.definitions.map(definition => definition.id))
      .toEqual(['explorer', 'researcher', 'reviewer']);
    for (const definition of snapshot.definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.model).toBeUndefined();
      expect(definition.contextFiles).toHaveLength(4);
      expect(definition.contextFiles[0].content).not.toContain('description:');
      expect(definition.sourceFiles[0].content).toContain('description:');
    }
  });

  it('parses multiline YAML and CRLF before stripping frontmatter from the child body', async () => {
    await define('reviewer', [
      '---', 'description: >-', '  Reviews changes', '  with evidence.',
      'model: { providerId: " test-provider ", modelId: "model:1" }',
      '---', '# Reviewer', 'Only body instructions.',
    ].join('\r\n'));
    const { definitions, diagnostics } = await loadAgentDefinitions(home);
    expect(diagnostics).toEqual([]);
    expect(definitions[0]).toMatchObject({
      id: 'reviewer', description: 'Reviews changes with evidence.',
      model: { providerId: 'test-provider', modelId: 'model:1' },
      contextFiles: [{
        path: 'IDENTITY.md', content: '# Reviewer\r\nOnly body instructions.',
      }],
    });
    expect(definitions[0].sourceFiles[0].content).toContain('model:');
  });

  it('accepts BOM and an empty body after valid frontmatter', async () => {
    await define('reviewer', '\uFEFF---\ndescription: Reviewer\n---');
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.definitions[0].description).toBe('Reviewer');
    expect(snapshot.definitions[0].contextFiles).toEqual([]);
    expect(snapshot.definitions[0].missingFiles).toEqual(['SOUL.md', 'AGENTS.md', 'TOOLS.md']);
    expect(Object.isFrozen(snapshot.definitions[0].missingFiles)).toBe(true);
  });

  it('distinguishes a missing Context file from a present empty file in the startup snapshot', async () => {
    const dir = await define('reviewer', '---\ndescription: Reviewer\n---\nbody');
    await writeFile(join(dir, 'SOUL.md'), '');
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.definitions[0].missingFiles).toEqual(['AGENTS.md', 'TOOLS.md']);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it.each([
    ['missing frontmatter', '# Just prose'],
    ['unclosed frontmatter', '---\ndescription: Reviewer'],
    ['frontmatter after prose', 'prose\n---\ndescription: Reviewer\n---\nbody'],
    ['invalid YAML', '---\ndescription: [invalid\n---\nbody'],
    ['duplicate keys', '---\ndescription: A\ndescription: B\n---\nbody'],
    ['missing description', '---\nmodel: { providerId: test, modelId: test }\n---\nbody'],
    ['blank description', '---\ndescription: "  "\n---\nbody'],
    ['nontext description', '---\ndescription: 123\n---\nbody'],
    ['array metadata', '---\n- description\n---\nbody'],
    ['unknown field', '---\ndescription: Reviewer\nenabled: true\n---\nbody'],
    ['invalid model shape', '---\ndescription: Reviewer\nmodel: inherit\n---\nbody'],
    ['blank model', '---\ndescription: Reviewer\nmodel: { providerId: test, modelId: " " }\n---\nbody'],
    ['invalid provider', '---\ndescription: Reviewer\nmodel: { providerId: "bad/id", modelId: test }\n---\nbody'],
    ['unknown model field', '---\ndescription: Reviewer\nmodel: { providerId: test, modelId: test, other: 1 }\n---\nbody'],
    ['YAML alias', '---\ndescription: &value Reviewer\nmodel: *value\n---\nbody'],
    ['YAML tag', '---\ndescription: !custom Reviewer\n---\nbody'],
  ])('diagnoses %s without hiding a healthy neighbor', async (_label, identity) => {
    await define('bad', identity);
    await define('good', '---\ndescription: Healthy Agent\n---\nhealthy body');
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.definitions.map(definition => definition.id)).toEqual(['good']);
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({
      agentId: 'bad', path: join(home, 'agents', 'bad', 'IDENTITY.md'),
      code: 'invalid_definition', message: expect.any(String),
    })]);
  });

  it('diagnoses missing identity and invalid IDs without scanning nested directories', async () => {
    await define('empty');
    await define('general-purpose', '---\ndescription: Reserved\n---\nbody');
    await define('Bad-ID', '---\ndescription: Invalid\n---\nbody');
    const dir = await define('outer');
    await mkdir(join(dir, 'inner'));
    await writeFile(join(dir, 'inner', 'IDENTITY.md'), '---\ndescription: Nested\n---\nbody');
    await writeFile(join(home, 'agents', 'README.md'), 'ignored');
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.diagnostics.map(item => item.agentId))
      .toEqual(['Bad-ID', 'empty', 'general-purpose', 'outer']);
  });

  it('does not follow a linked Agent directory outside the registry', async () => {
    const target = join(home, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'IDENTITY.md'), '---\ndescription: Outside\n---\nbody');
    await symlink(target, join(home, 'agents', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({
      agentId: 'linked', code: 'invalid_definition',
    })]);
  });

  it('rejects non-regular Context files', async () => {
    const dir = await define('reviewer', '---\ndescription: Reviewer\n---\nbody');
    await mkdir(join(dir, 'SOUL.md'));
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.diagnostics[0]).toMatchObject({
      code: 'invalid_definition', path: join(dir, 'SOUL.md'),
    });
  });

  it('reports individual I/O failures and fails explicitly on registry enumeration errors', async () => {
    await define('reviewer', '---\ndescription: Reviewer\n---\nbody');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('unreadable'), { code: 'EACCES' }));
    const snapshot = await loadAgentDefinitions(home);
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.diagnostics[0]).toMatchObject({
      agentId: 'reviewer', code: 'read_failed', message: expect.stringContaining('EACCES'),
    });
    const failure = Object.assign(new Error('enumeration failed'), { code: 'EIO' });
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(failure);
    await expect(loadAgentDefinitions(home)).rejects.toBe(failure);
  });

  it('retains a bounded, deeply immutable startup snapshot across disk edits and deletion', async () => {
    const body = 'BODY'.repeat(1_000);
    const source = `---\ndescription: Snapshot description\nmodel: { providerId: test, modelId: test }\n---\n${body}`;
    const dir = await define('reviewer', source);
    await writeFile(join(dir, 'SOUL.md'), 'SOUL'.repeat(1_000));
    const options = { maxFileChars: 2_000, maxTotalChars: 3_500 };
    const snapshot = await loadAgentDefinitions(home, options);
    const definition = snapshot.definitions[0];
    expect(definition.description).toBe('Snapshot description');
    expect(definition.contextFiles).toEqual(prepareContextFiles([
      { path: 'IDENTITY.md', content: body },
      { path: 'SOUL.md', content: 'SOUL'.repeat(1_000) },
    ], { ...options, warn: vi.fn() }));
    expect(definition.contextFiles.reduce((sum, file) => sum + file.content.length, 0))
      .toBeLessThanOrEqual(options.maxTotalChars);
    expect(definition.sourceFiles.reduce((sum, file) => sum + file.content.length, 0))
      .toBeLessThanOrEqual(options.maxTotalChars);
    expect(snapshot.diagnostics.every(item => item.code === 'context_truncated')).toBe(true);
    expect(snapshot.diagnostics.length).toBeGreaterThan(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.definitions)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.model)).toBe(true);
    expect(Object.isFrozen(definition.contextFiles)).toBe(true);
    expect(Object.isFrozen(definition.contextFiles[0])).toBe(true);
    expect(Object.isFrozen(definition.sourceFiles[0])).toBe(true);
    expect(Object.isFrozen(snapshot.diagnostics[0])).toBe(true);

    await writeFile(join(dir, 'IDENTITY.md'), '---\ndescription: Changed\n---\nchanged body');
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toContain('Changed');
    await rm(dir, { recursive: true });
    expect(definition.description).toBe('Snapshot description');
    expect(definition.contextFiles[0].content).not.toContain('changed body');
    expect((await loadAgentDefinitions(home)).definitions).toEqual([]);
  });

  it('treats an empty registry as initialized, but rejects a missing or non-directory registry', async () => {
    expect((await loadAgentDefinitions(home)).definitions).toEqual([]);
    await rm(join(home, 'agents'), { recursive: true });
    await expect(loadAgentDefinitions(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(home, 'agents'), 'not a directory');
    await expect(loadAgentDefinitions(home)).rejects.toThrow('must be a directory');
  });
});
