import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { discoverSkills, loadSkill } from './library.js';
import { validateSkillSelection } from './config.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

describe('Skills library', () => {
  let home: string;
  const source = (name: string, extra = '') =>
    `---\nname: ${name}\ndescription: Reviews changes.\n${extra}---\n# Instructions\nRead carefully.\n`;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'skills-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });
  async function define(parts: string[], content = source(parts.at(-1)!)) {
    const directory = join(home, 'skills', ...parts);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), content);
    return directory;
  }

  it('finds a root created later and returns flat sorted names from nested and hidden classifications', async () => {
    expect(await discoverSkills(home)).toEqual({ entries: [], diagnostics: [] });
    await define(['builtin', 'nested', 'review']);
    await define(['.custom', 'author']);
    expect((await discoverSkills(home)).entries.map(entry => entry.name)).toEqual(['author', 'review']);
    expect((await discoverSkills(home)).entries[1].relativeDirectory)
      .toBe(join('builtin', 'nested', 'review'));
  });

  it('stops below both valid and invalid instruction boundaries', async () => {
    await define(['outer']);
    await define(['outer', 'scripts', 'inner']);
    await define(['broken'], 'invalid');
    await define(['broken', 'example']);
    const catalog = await discoverSkills(home);
    expect(catalog.entries.map(entry => entry.name)).toEqual(['outer']);
    expect(catalog.diagnostics).toHaveLength(1);
  });

  it('excludes all conflicting names, preserves healthy siblings, and detects late conflicts during loading', async () => {
    await define(['one', 'review']);
    expect((await discoverSkills(home)).entries).toHaveLength(1);
    await define(['two', 'review']);
    await define(['healthy']);
    await expect(loadSkill(home, 'review')).rejects.toThrow('conflicting');
    const catalog = await discoverSkills(home);
    expect(catalog.entries.map(entry => entry.name)).toEqual(['healthy']);
    expect(catalog.diagnostics.map(entry => entry.code)).toEqual(['duplicate_name', 'duplicate_name']);
  });

  it('returns complete current source including optional and unknown metadata without Context budgets', async () => {
    const content = source('review', 'compatibility: Requires Python 3.11\nlicense: MIT\nmetadata: { owner: test }\ncustom: true\n')
      + 'x'.repeat(30_000);
    const directory = await define(['review']);
    await writeFile(join(directory, 'SKILL.md'), content);
    expect(await loadSkill(home, 'review')).toEqual({ name: 'review', directory, content });
    await rm(join(directory, 'SKILL.md'));
    await expect(loadSkill(home, 'review')).rejects.toThrow('missing or invalid');
  });

  it.each([
    '---\nname: other\ndescription: Test\n---\nbody',
    '---\nname: review\nname: review\ndescription: Test\n---\nbody',
    '---\nname: review\ndescription: &text Test\nextra: *text\n---\nbody',
    '---\nname: review\ndescription: ""\n---\nbody',
    '---\nname: review\ndescription: Test\n---\n ',
  ])('reports malformed packages without discarding healthy siblings', async content => {
    await define(['review'], content);
    await define(['healthy']);
    const catalog = await discoverSkills(home);
    expect(catalog.entries.map(entry => entry.name)).toEqual(['healthy']);
    expect(catalog.diagnostics[0].code).toBe('invalid_skill');
  });

  it('rejects linked directories and nonregular instruction files', async () => {
    const target = await define(['target']);
    await symlink(target, join(home, 'skills', 'linked'), 'junction');
    await mkdir(join(home, 'skills', 'broken', 'SKILL.md'), { recursive: true });
    const catalog = await discoverSkills(home);
    expect(catalog.entries.map(entry => entry.name)).toEqual(['target']);
    expect(catalog.diagnostics).toHaveLength(2);
  });

  it('rejects a linked discovery root', async () => {
    await mkdir(join(home, 'outside'));
    await symlink(join(home, 'outside'), join(home, 'skills'), 'junction');
    await expect(discoverSkills(home)).rejects.toThrow('not a link');
  });

  it('reports read failures and recovers on a subsequent request', async () => {
    await define(['review']);
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'EACCES' }));
    expect((await discoverSkills(home)).diagnostics[0].code).toBe('read_failed');
    expect((await discoverSkills(home)).entries).toHaveLength(1);
  });

  it.each([null, {}, ['UPPER'], ['bad--name'], ['../review'], ['review', 'review']])(
    'rejects invalid selection %j', value => { expect(() => validateSkillSelection(value)).toThrow(); },
  );
  it('accepts empty and valid selections', () => {
    expect(() => validateSkillSelection([])).not.toThrow();
    expect(() => validateSkillSelection(['review', 'skill-2'])).not.toThrow();
  });
});
