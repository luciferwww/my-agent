import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureWorkspace } from './init.js';

describe('ensureWorkspace', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'workspace-test-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('creates .agent/ directory and all template files when nothing exists', async () => {
    await ensureWorkspace(workspaceDir);

    const agentDir = join(workspaceDir, '.agent');
    const identity = await readFile(join(agentDir, 'IDENTITY.md'), 'utf-8');
    const soul = await readFile(join(agentDir, 'SOUL.md'), 'utf-8');
    const agents = await readFile(join(agentDir, 'AGENTS.md'), 'utf-8');
    const tools = await readFile(join(agentDir, 'TOOLS.md'), 'utf-8');

    expect(identity).toContain('# Identity');
    expect(soul).toContain('# Soul');
    expect(agents).toContain('# Agents');
    expect(tools).toContain('# Tools');
  });

  it('does not overwrite existing files', async () => {
    const agentDir = join(workspaceDir, '.agent');
    await mkdir(agentDir, { recursive: true });

    const customContent = '# My Custom Identity\n- **Name:** Aria';
    await writeFile(join(agentDir, 'IDENTITY.md'), customContent, 'utf-8');

    await ensureWorkspace(workspaceDir);

    const identity = await readFile(join(agentDir, 'IDENTITY.md'), 'utf-8');
    expect(identity).toBe(customContent);
  });

  it('creates only missing files when some already exist', async () => {
    const agentDir = join(workspaceDir, '.agent');
    await mkdir(agentDir, { recursive: true });

    const customSoul = '# My Soul\nBe direct.';
    await writeFile(join(agentDir, 'SOUL.md'), customSoul, 'utf-8');

    await ensureWorkspace(workspaceDir);

    // SOUL.md should be preserved
    const soul = await readFile(join(agentDir, 'SOUL.md'), 'utf-8');
    expect(soul).toBe(customSoul);

    // Other files should be created from template
    const identity = await readFile(join(agentDir, 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('# Identity');

    const agents = await readFile(join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# Agents');

    const tools = await readFile(join(agentDir, 'TOOLS.md'), 'utf-8');
    expect(tools).toContain('# Tools');
  });

  it('creates .agent/ directory even if workspace directory does not exist', async () => {
    const nestedDir = join(workspaceDir, 'nested', 'deep');
    await ensureWorkspace(nestedDir);

    const identity = await readFile(join(nestedDir, '.agent', 'IDENTITY.md'), 'utf-8');
    expect(identity).toContain('# Identity');
  });
});
