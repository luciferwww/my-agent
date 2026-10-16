import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireAgentHomeLock,
  AgentHomeLockedError,
} from './agent-home-lock.js';

describe('agent home lock', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createAgentHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'my-agent-home-lock-'));
    roots.push(root);
    return root;
  }

  it('excludes another Runtime and releases ownership', async () => {
    const agentHome = await createAgentHome();
    const first = await acquireAgentHomeLock(agentHome);

    await expect(acquireAgentHomeLock(agentHome)).rejects.toEqual(
      expect.objectContaining({
        name: AgentHomeLockedError.name,
        ownerPid: process.pid,
      }),
    );

    await first.release();
    const second = await acquireAgentHomeLock(agentHome);
    await second.release();
  });

  it('reclaims a lock owned by a process that no longer exists', async () => {
    const agentHome = await createAgentHome();
    const lockPath = join(agentHome, '.my-agent.pid');
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      instanceId: randomUUID(),
      startedAt: new Date(0).toISOString(),
    }));

    const lock = await acquireAgentHomeLock(agentHome);
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
    await lock.release();
  });
});
