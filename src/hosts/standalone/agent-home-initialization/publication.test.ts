import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { publishAgentHome } from './publication.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

describe('Agent Home publication', () => {
  it('atomically replaces the expected existing configuration', async () => {
    const agentHome = await createAgentHome();
    await writeFile(join(agentHome, 'config.json'), '{"before":true}\n', 'utf8');

    await publishAgentHome(agentHome, '{"after":true}\n', '{"before":true}\n');

    await expect(readFile(join(agentHome, 'config.json'), 'utf8'))
      .resolves.toBe('{"after":true}\n');
  });

  it('preserves a concurrently changed configuration', async () => {
    const agentHome = await createAgentHome();
    await writeFile(join(agentHome, 'config.json'), '{"concurrent":true}\n', 'utf8');

    await expect(publishAgentHome(
      agentHome,
      '{"after":true}\n',
      '{"before":true}\n',
    )).rejects.toThrow('configuration changed during editing');

    await expect(readFile(join(agentHome, 'config.json'), 'utf8'))
      .resolves.toBe('{"concurrent":true}\n');
  });
});

async function createAgentHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'my-agent-publication-'));
  roots.push(root);
  const agentHome = join(root, 'agent-home');
  await mkdir(agentHome, { recursive: true });
  return agentHome;
}
