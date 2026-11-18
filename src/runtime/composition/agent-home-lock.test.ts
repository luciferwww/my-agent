import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('does not reject an unlisted platform name when the native backend can acquire', async () => {
    const agentHome = await createAgentHome();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('Missing process.platform descriptor.');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'freebsd' });
    try {
      const lock = await acquireAgentHomeLock(agentHome);
      try {
        await expect(acquireAgentHomeLock(agentHome)).rejects.toBeInstanceOf(AgentHomeLockedError);
      } finally {
        await lock.release();
      }
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('excludes another Runtime and releases ownership', async () => {
    const agentHome = await createAgentHome();
    const first = await acquireAgentHomeLock(agentHome);

    await expect(acquireAgentHomeLock(agentHome)).rejects.toEqual(
      expect.objectContaining({
        name: AgentHomeLockedError.name,
        ownerPid: process.pid,
      }),
    );

    const path = join(agentHome, '.my-agent.pid');
    const metadata = await readFile(path, 'utf8');
    expect((await stat(path)).size).toBe(Buffer.byteLength(metadata));
    await first.release();
    await first.release();
    expect(await readFile(path, 'utf8')).toBe(metadata);
    const second = await acquireAgentHomeLock(agentHome);
    await first.release();
    await expect(acquireAgentHomeLock(agentHome)).rejects.toBeInstanceOf(AgentHomeLockedError);
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

  it.each(['', '{invalid', JSON.stringify({
    pid: process.pid,
    instanceId: 'unrelated-live-process',
    startedAt: new Date(0).toISOString(),
  })])('does not use existing metadata to decide admission: %s', async metadata => {
    const agentHome = await createAgentHome();
    const path = join(agentHome, '.my-agent.pid');
    await writeFile(path, metadata);
    const lock = await acquireAgentHomeLock(agentHome);
    try {
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid });
      await expect(acquireAgentHomeLock(agentHome)).rejects.toBeInstanceOf(AgentHomeLockedError);
    } finally {
      await lock.release();
    }
  });

  it('admits only one of two concurrent acquisitions without truncating the winner', async () => {
    const agentHome = await createAgentHome();
    const results = await Promise.allSettled([
      acquireAgentHomeLock(agentHome),
      acquireAgentHomeLock(agentHome),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    try {
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(AgentHomeLockedError);
      }
      expect(JSON.parse(await readFile(join(agentHome, '.my-agent.pid'), 'utf8')))
        .toMatchObject({ pid: process.pid });
    } finally {
      await Promise.all(results.flatMap(result => result.status === 'fulfilled' ? [result.value.release()] : []));
    }
  });
});
