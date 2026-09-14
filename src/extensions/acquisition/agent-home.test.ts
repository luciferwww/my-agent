import { lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentHome } from './agent-home.js';

describe('resolveAgentHome', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'my-agent-home-'));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('uses explicit path before environment and default', async () => {
    const explicitPath = join(temporaryRoot, 'explicit');
    await expect(resolveAgentHome({
      explicitPath,
      environment: { MY_AGENT_HOME: join(temporaryRoot, 'environment') },
      homeDirectory: join(temporaryRoot, 'home'),
    })).resolves.toBe(normalize(explicitPath));
  });

  it('uses environment before the default', async () => {
    const environmentPath = join(temporaryRoot, 'environment');
    await expect(resolveAgentHome({
      environment: { MY_AGENT_HOME: environmentPath },
      homeDirectory: join(temporaryRoot, 'home'),
    })).resolves.toBe(normalize(environmentPath));
  });

  it('defaults to .my-agent under the supplied home directory', async () => {
    await expect(resolveAgentHome({
      environment: {},
      homeDirectory: temporaryRoot,
    })).resolves.toBe(join(temporaryRoot, '.my-agent'));
  });

  it('expands a leading home marker', async () => {
    await expect(resolveAgentHome({
      explicitPath: '~/agent-home',
      environment: {},
      homeDirectory: temporaryRoot,
    })).resolves.toBe(join(temporaryRoot, 'agent-home'));
  });

  it.each(['', '   ', 'relative/path'])('rejects invalid explicit value %j without falling through', async (explicitPath) => {
    await expect(resolveAgentHome({
      explicitPath,
      environment: { MY_AGENT_HOME: temporaryRoot },
      homeDirectory: temporaryRoot,
    })).rejects.toMatchObject({
      code: 'AGENT_HOME_INVALID',
    });
  });

  it('rejects an invalid environment value without falling through', async () => {
    await expect(resolveAgentHome({
      environment: { MY_AGENT_HOME: 'relative' },
      homeDirectory: temporaryRoot,
    })).rejects.toMatchObject({
      code: 'AGENT_HOME_INVALID',
    });
  });

  it('lexically normalizes a missing Agent Home without creating it', async () => {
    const missingPath = join(temporaryRoot, 'parent', '..', 'missing');
    const result = await resolveAgentHome({ explicitPath: missingPath });

    expect(result).toBe(normalize(missingPath));
    await expect(lstat(result)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the canonical path for an existing Agent Home alias', async () => {
    const actualPath = join(temporaryRoot, 'actual');
    const aliasPath = join(temporaryRoot, 'alias');
    await mkdir(actualPath);
    await symlink(actualPath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveAgentHome({ explicitPath: aliasPath }))
      .resolves.toBe(await realpath(actualPath));
  });

  it('rejects an existing regular file as Agent Home', async () => {
    const filePath = join(temporaryRoot, 'not-a-directory');
    await writeFile(filePath, 'content');

    await expect(resolveAgentHome({ explicitPath: filePath })).rejects.toMatchObject({
      code: 'AGENT_HOME_INVALID',
    });
  });
});
