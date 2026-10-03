import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureAgentConfigDocument } from './agent-config-bootstrap.js';
import { AgentConfigError } from './agent-config-errors.js';
import { loadAgentConfig } from './agent-config-loader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ensureAgentConfigDocument', () => {
  it('creates a missing Agent Home and exact empty document', async () => {
    const root = await temporaryRoot();
    const agentHome = join(root, 'missing-agent-home');

    await ensureAgentConfigDocument({ agentHome });

    await expect(readFile(join(agentHome, 'config.json'), 'utf8')).resolves.toBe('{}\n');
  });

  it('creates the exact empty document in an existing empty Agent Home', async () => {
    const agentHome = await temporaryRoot();

    await ensureAgentConfigDocument({ agentHome });

    await expect(readFile(join(agentHome, 'config.json'), 'utf8')).resolves.toBe('{}\n');
  });

  it('preserves every byte of an existing document', async () => {
    const agentHome = await temporaryRoot();
    const content = '{\r\n  "host": { "mode": "headless" }\r\n}\r\n';
    const configPath = join(agentHome, 'config.json');
    await writeFile(configPath, content, 'utf8');

    await ensureAgentConfigDocument({ agentHome });

    await expect(readFile(configPath, 'utf8')).resolves.toBe(content);
  });

  it('preserves malformed, wrong-type, and symlinked existing paths', async () => {
    const root = await temporaryRoot();

    const malformedHome = join(root, 'malformed-home');
    await mkdir(malformedHome);
    await writeFile(join(malformedHome, 'config.json'), '{', 'utf8');
    await ensureAgentConfigDocument({ agentHome: malformedHome });
    await expect(readFile(join(malformedHome, 'config.json'), 'utf8')).resolves.toBe('{');

    const wrongTypeHome = join(root, 'wrong-type-home');
    await mkdir(join(wrongTypeHome, 'config.json'), { recursive: true });
    await ensureAgentConfigDocument({ agentHome: wrongTypeHome });
    expect((await stat(join(wrongTypeHome, 'config.json'))).isDirectory()).toBe(true);

    const symlinkHome = join(root, 'symlink-home');
    const target = join(root, 'linked-config.json');
    await mkdir(symlinkHome);
    await writeFile(target, '{"host":{"mode":"headless"}}\n', 'utf8');
    await symlink(target, join(symlinkHome, 'config.json'), 'file');
    await ensureAgentConfigDocument({ agentHome: symlinkHome });
    await expect(readFile(target, 'utf8')).resolves.toBe('{"host":{"mode":"headless"}}\n');
  });

  it('does not read an existing document and treats only EEXIST as success', async () => {
    const ensureDirectory = vi.fn(async () => undefined);
    const createTextFile = vi.fn(async (_path: string, _content: string) => {
      throw Object.assign(new Error('raw path must not escape'), { code: 'EEXIST' });
    });

    await expect(ensureAgentConfigDocument(
      { agentHome: 'C:/agent-home' },
      { ensureDirectory, createTextFile },
    )).resolves.toBeUndefined();

    expect(ensureDirectory).toHaveBeenCalledWith('C:/agent-home');
    expect(createTextFile).toHaveBeenCalledWith(join('C:/agent-home', 'config.json'), '{}\n');
  });

  it('classifies parent creation without leaking the raw failure', async () => {
    const raw = new Error('secret C:/private/path');

    await expect(ensureAgentConfigDocument(
      { agentHome: 'C:/agent-home' },
      {
        ensureDirectory: async () => { throw raw; },
        createTextFile: async () => undefined,
      },
    )).rejects.toMatchObject({
      code: 'AGENT_HOME_CREATE_FAILED',
      message: 'Agent Home could not be created for configuration bootstrap.',
    });
  });

  it('classifies create and partial-write failures while preserving controlled bytes', async () => {
    const root = await temporaryRoot();
    const agentHome = join(root, 'agent-home');
    const configPath = join(agentHome, 'config.json');

    await expect(ensureAgentConfigDocument(
      { agentHome },
      {
        ensureDirectory: async (path) => {
          await mkdir(path, { recursive: true });
        },
        createTextFile: async (path) => {
          await writeFile(path, '{', { encoding: 'utf8', flag: 'wx' });
          throw new Error('raw create failure');
        },
      },
    )).rejects.toMatchObject({
      code: 'FILE_CREATE_FAILED',
      message: 'Agent configuration file could not be created.',
    });
    await expect(readFile(configPath, 'utf8')).resolves.toBe('{');
    await expect(loadAgentConfig({ agentHome })).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });

  it('rejects non-EEXIST create failures as AgentConfigError', async () => {
    const error = await captureError(ensureAgentConfigDocument(
      { agentHome: 'C:/agent-home' },
      {
        ensureDirectory: async () => undefined,
        createTextFile: async () => {
          throw Object.assign(new Error('private raw failure'), { code: 'EACCES' });
        },
      },
    ));

    expect(error).toBeInstanceOf(AgentConfigError);
    expect(error).toMatchObject({ code: 'FILE_CREATE_FAILED' });
    expect(error.message).not.toContain('private raw failure');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-config-bootstrap-'));
  roots.push(root);
  return root;
}

async function captureError(promise: Promise<unknown>): Promise<AgentConfigError> {
  try {
    await promise;
  } catch (error) {
    return error as AgentConfigError;
  }
  throw new Error('Expected operation to reject.');
}
