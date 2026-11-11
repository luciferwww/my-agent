import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureAgentContext } from './init.js';

vi.mock('fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('fs/promises')>(),
}));

describe('ensureAgentContext', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'agent-context-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(agentHome, { recursive: true, force: true });
  });

  it('creates all template files at the Agent Home root when nothing exists', async () => {
    await ensureAgentContext(agentHome);

    const identity = await readFile(join(agentHome, 'IDENTITY.md'), 'utf-8');
    const soul = await readFile(join(agentHome, 'SOUL.md'), 'utf-8');
    const agents = await readFile(join(agentHome, 'AGENTS.md'), 'utf-8');
    const tools = await readFile(join(agentHome, 'TOOLS.md'), 'utf-8');

    expect(identity).toContain('# Identity');
    expect(soul).toContain('# Soul');
    expect(agents).toContain('# Agents');
    expect(agents).toContain('are automatically');
    expect(agents).toContain('loaded into the system prompt');
    expect(agents).toContain('Do not read these files again merely because a session starts.');
    expect(agents).not.toContain('Before doing anything else:');
    expect(tools).toContain('# Tools');
  });

  it('does not overwrite existing files', async () => {
    const customContent = '# My Custom Identity\n- **Name:** Aria';
    await writeFile(join(agentHome, 'IDENTITY.md'), customContent, 'utf-8');

    await ensureAgentContext(agentHome);

    const identity = await readFile(join(agentHome, 'IDENTITY.md'), 'utf-8');
    expect(identity).toBe(customContent);
  });

  it('creates only missing files when some already exist', async () => {
    const customSoul = '# My Soul\nBe direct.';
    await writeFile(join(agentHome, 'SOUL.md'), customSoul, 'utf-8');

    await ensureAgentContext(agentHome);

    // SOUL.md should be preserved
    const soul = await readFile(join(agentHome, 'SOUL.md'), 'utf-8');
    expect(soul).toBe(customSoul);

    // Other files should be created from template
    const identity = await readFile(join(agentHome, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('# Identity');

    const agents = await readFile(join(agentHome, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# Agents');

    const tools = await readFile(join(agentHome, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('# Tools');
  });

  it('creates the Agent Home root even if it does not exist', async () => {
    const nestedAgentHome = join(agentHome, 'nested', 'deep');
    await ensureAgentContext(nestedAgentHome);

    const identity = await readFile(join(nestedAgentHome, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('# Identity');
  });

  it('does not read, modify, or delete a pre-existing obsolete .agent directory', async () => {
    const obsoleteDir = join(agentHome, '.agent');
    await mkdir(obsoleteDir);
    await writeFile(join(obsoleteDir, 'IDENTITY.md'), '# Obsolete Identity', 'utf-8');

    await ensureAgentContext(agentHome);

    expect(await readFile(join(obsoleteDir, 'IDENTITY.md'), 'utf-8')).toBe('# Obsolete Identity');
    expect(await readFile(join(agentHome, 'IDENTITY.md'), 'utf-8')).toContain('# Identity');
  });

  it('seeds complete named Agent templates only once', async () => {
    await ensureAgentContext(agentHome);
    const agentsDir = join(agentHome, 'agents');
    expect((await readdir(agentsDir)).sort()).toEqual(['explorer', 'researcher', 'reviewer']);
    for (const id of await readdir(agentsDir)) {
      expect((await readdir(join(agentsDir, id))).sort())
        .toEqual(['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md']);
      expect(await readFile(join(agentsDir, id, 'IDENTITY.md'), 'utf8'))
        .toMatch(/^---\r?\ndescription: /u);
    }

    await writeFile(join(agentsDir, 'reviewer', 'IDENTITY.md'), 'user content');
    await rm(join(agentsDir, 'explorer'), { recursive: true });
    await ensureAgentContext(agentHome);
    expect(await readFile(join(agentsDir, 'reviewer', 'IDENTITY.md'), 'utf8')).toBe('user content');
    expect((await readdir(agentsDir)).sort()).toEqual(['researcher', 'reviewer']);
    expect((await readdir(agentHome)).filter(name => name.startsWith('.agents-'))).toEqual([]);
  });

  it('preserves an existing empty agents directory', async () => {
    await mkdir(join(agentHome, 'agents'));
    await ensureAgentContext(agentHome);
    expect(await readdir(join(agentHome, 'agents'))).toEqual([]);
  });

  it('rejects a non-directory agents path without modifying it', async () => {
    await writeFile(join(agentHome, 'agents'), 'not a directory');
    await expect(ensureAgentContext(agentHome)).rejects.toThrow('must be a directory');
    expect(await readFile(join(agentHome, 'agents'), 'utf8')).toBe('not a directory');
  });

  it('does not publish a partial template directory after a copy failure', async () => {
    const failure = Object.assign(new Error('copy failed'), { code: 'EIO' });
    vi.spyOn(fs, 'cp').mockImplementationOnce(async (_source, target) => {
      await mkdir(join(String(target), 'partial'));
      await writeFile(join(String(target), 'partial', 'IDENTITY.md'), 'partial copy');
      throw failure;
    });
    await expect(ensureAgentContext(agentHome)).rejects.toBe(failure);
    expect(await readdir(agentHome)).not.toContain('agents');
    expect((await readdir(agentHome)).filter(name => name.startsWith('.agents-'))).toEqual([]);

    await ensureAgentContext(agentHome);
    expect((await readdir(join(agentHome, 'agents'))).sort())
      .toEqual(['explorer', 'researcher', 'reviewer']);
  });

  it('reports both publication and temporary-directory cleanup failures', async () => {
    const publicationFailure = new Error('publication failed');
    const cleanupFailure = new Error('cleanup failed');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(publicationFailure);
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(cleanupFailure);
    await expect(ensureAgentContext(agentHome)).rejects.toMatchObject({
      errors: [publicationFailure, cleanupFailure],
    });
    expect(await readdir(agentHome)).not.toContain('agents');
  });
});