import { lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readHostExtensionsConfig } from './host-config.js';

describe('readHostExtensionsConfig', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'my-agent-host-config-'));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('returns an enabled empty namespace when Agent Home is missing', async () => {
    const missingHome = join(temporaryRoot, 'missing');

    await expect(readHostExtensionsConfig(missingHome)).resolves.toEqual({
      enabled: true,
      entries: {},
    });
    await expect(lstat(missingHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns an enabled empty namespace when config or extensions is missing', async () => {
    const agentHome = join(temporaryRoot, 'home');
    await mkdir(agentHome);

    await expect(readHostExtensionsConfig(agentHome)).resolves.toEqual({
      enabled: true,
      entries: {},
    });
    await writeFile(join(agentHome, 'config.json'), JSON.stringify({ other: true }));
    await expect(readHostExtensionsConfig(agentHome)).resolves.toEqual({
      enabled: true,
      entries: {},
    });
  });

  it('reads the global kill switch and preserves isolated raw entry values', async () => {
    const entries = {
      alpha: { enabled: true, config: { retries: 2 } },
      malformed: 'isolate-me-later',
    };
    await writeConfig(temporaryRoot, {
      extensions: { enabled: false, entries },
    });

    const result = await readHostExtensionsConfig(temporaryRoot);

    expect(result).toEqual({ enabled: false, entries });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries['alpha'])).toBe(true);
    expect(Object.isFrozen((result.entries['alpha'] as { config: object }).config)).toBe(true);
  });

  it.each([
    ['malformed JSON', '{ invalid'],
    ['array root', JSON.stringify([])],
    ['invalid extensions namespace', JSON.stringify({ extensions: [] })],
    ['invalid global enabled', JSON.stringify({ extensions: { enabled: 'yes' } })],
    ['invalid entries container', JSON.stringify({ extensions: { entries: [] } })],
  ])('rejects %s as fatal Host configuration', async (_label, source) => {
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(join(temporaryRoot, 'config.json'), source);

    await expect(readHostExtensionsConfig(temporaryRoot))
      .rejects.toMatchObject({
        code: 'HOST_CONFIG_INVALID',
      });
  });

  it('rejects an existing config path that cannot be read as a file', async () => {
    await mkdir(join(temporaryRoot, 'config.json'));

    await expect(readHostExtensionsConfig(temporaryRoot))
      .rejects.toMatchObject({
        code: 'HOST_CONFIG_INVALID',
      });
  });
});

async function writeConfig(agentHome: string, value: unknown): Promise<void> {
  await mkdir(agentHome, { recursive: true });
  await writeFile(join(agentHome, 'config.json'), JSON.stringify(value));
}
