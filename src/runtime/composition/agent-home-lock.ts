/// <reference path="./fs-native-extensions.d.ts" />

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import locks from 'fs-native-extensions';

const LOCK_FILE = '.my-agent.pid';
const MAX_METADATA_BYTES = 4096;
const LOCK_OFFSET = process.platform === 'win32' ? 1024 * 1024 : 0;
const LOCK_LENGTH = process.platform === 'win32' ? 1 : 0;
// Keep ownership alive even if a failed Runtime is no longer referenced.
const heldFiles = new Set<FileHandle>();

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
    metadataError?: unknown,
  ) {
    super(ownerPid === undefined
      ? `Agent home is locked; owner metadata is ${metadataError === undefined ? 'unavailable' : 'unreadable'}: "${lockPath}".`
      : `Agent home is already in use by process ${ownerPid}: "${lockPath}".`,
    metadataError === undefined ? undefined : { cause: metadataError });
    this.name = 'AgentHomeLockedError';
  }
}

export async function acquireAgentHomeLock(agentHome: string): Promise<AgentHomeLock> {
  await mkdir(agentHome, { recursive: true });
  const lockPath = join(agentHome, LOCK_FILE);
  const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error(`Agent Home lock destination is not a regular file: "${lockPath}".`);
    }
    if (!locks.tryLock(file.fd, LOCK_OFFSET, LOCK_LENGTH)) {
      let existing: AgentHomeLockRecord | undefined;
      try {
        existing = await readLockRecord(file);
      } catch (error) {
        throw new AgentHomeLockedError(lockPath, undefined, error);
      }
      throw new AgentHomeLockedError(lockPath, existing?.pid);
    }
    heldFiles.add(file);
    const record: AgentHomeLockRecord = {
      pid: process.pid,
      instanceId: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const metadata = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES) {
      throw new Error('Agent Home lock metadata exceeds its size bound.');
    }
    await file.truncate(0);
    await file.writeFile(metadata, 'utf8');
    let releasePromise: Promise<void> | undefined;
    return Object.freeze({
      release(): Promise<void> {
        releasePromise ??= file.close().then(() => { heldFiles.delete(file); });
        return releasePromise;
      },
    });
  } catch (error) {
    try {
      await file.close();
      heldFiles.delete(file);
    } catch (cleanupError) {
      heldFiles.add(file);
      throw new AggregateError(
        [error, cleanupError],
        'Agent Home lock acquisition failed and its descriptor could not be closed.',
      );
    }
    throw error;
  }
}

async function readLockRecord(file: FileHandle): Promise<AgentHomeLockRecord | undefined> {
  let value: unknown;
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_METADATA_BYTES) return undefined;
    value = JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    typeof value !== 'object'
    || value === null
    || !('pid' in value) || typeof value.pid !== 'number'
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !('instanceId' in value) || typeof value.instanceId !== 'string'
    || !('startedAt' in value) || typeof value.startedAt !== 'string'
  ) {
    return undefined;
  }
  return { pid: value.pid, instanceId: value.instanceId, startedAt: value.startedAt };
}
