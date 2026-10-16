import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_FILE = '.my-agent.pid';

interface AgentHomeLockRecord {
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}

export interface AgentHomeLock {
  release(): Promise<void>;
}

export class AgentHomeLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly ownerPid?: number,
  ) {
    super(ownerPid === undefined
      ? `Agent home is locked by an unknown instance: "${lockPath}".`
      : `Agent home is already in use by process ${ownerPid}: "${lockPath}".`);
    this.name = 'AgentHomeLockedError';
  }
}

export async function acquireAgentHomeLock(agentHome: string): Promise<AgentHomeLock> {
  await mkdir(agentHome, { recursive: true });
  const lockPath = join(agentHome, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt++) {
    const record: AgentHomeLockRecord = {
      pid: process.pid,
      instanceId: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return createLockHandle(lockPath, record.instanceId);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    const existing = await readLockRecord(lockPath);
    if (!existing || isProcessAlive(existing.pid) || attempt > 0) {
      throw new AgentHomeLockedError(lockPath, existing?.pid);
    }

    const stalePath = `${lockPath}.${randomUUID()}.stale`;
    try {
      await rename(lockPath, stalePath);
      await unlink(stalePath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  throw new AgentHomeLockedError(lockPath);
}

function createLockHandle(lockPath: string, instanceId: string): AgentHomeLock {
  let released = false;
  return Object.freeze({
    async release(): Promise<void> {
      if (released) return;
      const record = await readLockRecord(lockPath);
      if (!record || record.instanceId !== instanceId) {
        throw new Error(`Agent home lock ownership was lost: "${lockPath}".`);
      }
      await unlink(lockPath);
      released = true;
    },
  });
}

async function readLockRecord(lockPath: string): Promise<AgentHomeLockRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    typeof value !== 'object'
    || value === null
    || !Number.isSafeInteger((value as { pid?: unknown }).pid)
    || (value as { pid: number }).pid < 1
    || typeof (value as { instanceId?: unknown }).instanceId !== 'string'
    || typeof (value as { startedAt?: unknown }).startedAt !== 'string'
  ) {
    return undefined;
  }
  return value as AgentHomeLockRecord;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    if (errorCode(error) === 'EPERM') return true;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}
