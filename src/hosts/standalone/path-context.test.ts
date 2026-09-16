import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveStandaloneHostPathContext } from './path-context.js';

describe('resolveStandaloneHostPathContext', () => {
  let temporaryRoot: string;
  let installDir: string;
  let modulePath: string;
  let homeDirectory: string;
  let startupCwd: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'standalone-path-context-'));
    installDir = join(temporaryRoot, 'installation');
    modulePath = join(installDir, 'dist', 'host', 'hosts', 'standalone', 'entry.js');
    homeDirectory = join(temporaryRoot, 'home');
    startupCwd = join(temporaryRoot, 'startup');
    await mkdir(dirname(modulePath), { recursive: true });
    await mkdir(homeDirectory);
    await mkdir(startupCwd);
    await writeFile(modulePath, 'export {};\n', 'utf8');
    await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'my-agent' }), 'utf8');
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('derives immutable package and default Agent Home paths', async () => {
    const result = await resolveStandaloneHostPathContext({
      moduleUrl: pathToFileURL(modulePath).href,
      homeDirectory,
      startupCwd,
    });

    expect(result).toEqual({
      installDir: await realpath(installDir),
      agentHome: join(homeDirectory, '.my-agent'),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('canonicalizes an existing Agent Home alias without creating a missing default', async () => {
    const actualAgentHome = join(temporaryRoot, 'actual-agent-home');
    const agentHomeAlias = join(homeDirectory, '.my-agent');
    await mkdir(actualAgentHome);
    await symlink(
      actualAgentHome,
      agentHomeAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await resolveStandaloneHostPathContext({
      moduleUrl: pathToFileURL(modulePath).href,
      homeDirectory,
      startupCwd,
    });

    expect(result.agentHome).toBe(await realpath(actualAgentHome));
  });

  it('rejects a module outside the expected package without leaking its path', async () => {
    const unrelatedModule = join(temporaryRoot, 'unrelated', 'entry.js');
    await mkdir(dirname(unrelatedModule));
    await writeFile(unrelatedModule, 'export {};\n', 'utf8');

    const error = await captureFailure({
      moduleUrl: pathToFileURL(unrelatedModule).href,
      homeDirectory,
      startupCwd,
    });

    expect(error).toMatchObject({ code: 'INSTALL_DIR_INVALID' });
    expect(error.message).not.toContain(temporaryRoot);
  });

  it('rejects an existing non-directory Agent Home', async () => {
    await writeFile(join(homeDirectory, '.my-agent'), 'not a directory', 'utf8');

    await expect(resolveStandaloneHostPathContext({
      moduleUrl: pathToFileURL(modulePath).href,
      homeDirectory,
      startupCwd,
    })).rejects.toMatchObject({ code: 'AGENT_HOME_INVALID' });
  });

  it('resolves a relative Agent Home override against startup CWD', async () => {
    const result = await resolveStandaloneHostPathContext({
      moduleUrl: pathToFileURL(modulePath).href,
      homeDirectory,
      startupCwd,
      agentHomeArgument: join('profiles', 'one'),
    });

    expect(result.agentHome).toBe(normalize(join(startupCwd, 'profiles', 'one')));
  });

  it('uses and canonicalizes an explicit absolute Agent Home override', async () => {
    const actualAgentHome = join(temporaryRoot, 'explicit-agent-home');
    await mkdir(actualAgentHome);

    const result = await resolveStandaloneHostPathContext({
      moduleUrl: pathToFileURL(modulePath).href,
      homeDirectory,
      startupCwd,
      agentHomeArgument: actualAgentHome,
    });

    expect(result.agentHome).toBe(await realpath(actualAgentHome));
  });

  it('rejects a relative override when startup CWD is not absolute', async () => {
    await expect(resolveStandaloneHostPathContext({
      moduleUrl: pathToFileURL(modulePath).href,
      homeDirectory,
      startupCwd: 'relative',
      agentHomeArgument: 'agent-home',
    })).rejects.toMatchObject({ code: 'AGENT_HOME_INVALID' });
  });

  async function captureFailure(
    options: Parameters<typeof resolveStandaloneHostPathContext>[0],
  ): Promise<Error & { readonly code?: string }> {
    try {
      await resolveStandaloneHostPathContext(options);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      return error as Error & { readonly code?: string };
    }
    throw new Error('Expected path resolution to reject.');
  }
});