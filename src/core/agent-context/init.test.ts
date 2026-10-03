import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureAgentContext } from './init.js';

describe('ensureAgentContext', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'agent-context-test-'));
  });

  afterEach(async () => {
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
});