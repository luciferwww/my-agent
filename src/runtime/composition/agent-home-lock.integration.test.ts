import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const lockModule = new URL('./agent-home-lock.ts', import.meta.url).href;
const runtimeModule = new URL('../index.ts', import.meta.url).href;
const configModule = new URL('../../platform/config/index.ts', import.meta.url).href;
const sessionModule = new URL('../../core/session/index.ts', import.meta.url).href;
const childSource = `
  const [home, mode] = process.argv.slice(1);
  const { acquireAgentHomeLock } = await import(${JSON.stringify(lockModule)});
  let handle;
  let markChannelStop;
  const channelStop = new Promise(resolve => { markChannelStop = resolve; });
  process.on('message', async command => {
    try {
      if (command === 'acquire') {
        if (mode === 'lock') {
          handle = await acquireAgentHomeLock(home);
        } else {
          const { RuntimeApp } = await import(${JSON.stringify(runtimeModule)});
          const { loadAgentConfig } = await import(${JSON.stringify(configModule)});
          const { SessionManager } = await import(${JSON.stringify(sessionModule)});
          const snapshot = await loadAgentConfig({ agentHome: home });
          handle = await RuntimeApp.create({
            agentHome: home,
            applicationConfig: snapshot.application,
            deadlinePolicy: { shutdownOverallMs: 200, candidateCleanupMs: 200 },
            ...(mode === 'failed-retirement' ? {
              loadedUnits: [{
                unitId: 'fixture-channel',
                source: 'external',
                orderKey: 'fixture-channel',
                required: false,
                initiallyEnabled: true,
                dependencies: [],
                async create() {
                  return {
                    registration: {
                      id: 'fixture-channel',
                      source: 'external',
                      register(api) {
                        api.registerChannel({
                          id: 'fixture-channel',
                          create: () => ({
                            id: 'fixture-channel',
                            completion: new Promise(() => {}),
                            interaction: {
                              sendInteractionRequest() {
                                return { status: 'unavailable', reason: 'delivery_failed' };
                              },
                              sendInteractionClosed() {},
                              onInteractionResponse() {},
                            },
                            onMessage() {},
                            send() {},
                            start() {},
                            stop() {
                              markChannelStop();
                              throw new Error('fixture channel stop failed');
                            },
                          }),
                        });
                      },
                    },
                    start() {},
                    stop() {},
                  };
                },
              }],
            } : {}),
            dependencies: {
              createSessionManager(home, options) {
                const manager = new SessionManager(home, options);
                if (mode === 'incomplete-close' || mode === 'incomplete-startup') {
                  manager.close = () => new Promise(() => {});
                }
                return manager;
              },
              ...(mode.endsWith('startup') ? {
                createAgentRunner() { throw new Error('fixture startup failure'); },
              } : {}),
            },
          });
        }
        process.send({ kind: 'acquired', pid: process.pid });
      } else if (command === 'retire') {
        const result = await handle.composition.disableUnit('fixture-channel');
        if (result.outcome !== 'published') throw new Error('Fixture Channel was not retired.');
        await channelStop;
        process.send({ kind: 'retired' });
      } else if (command === 'close') {
        const report = await handle.close();
        handle = undefined;
        globalThis.gc();
        process.send({ kind: 'closed', report });
      } else if (command === 'release') {
        await handle.release();
        handle = undefined;
        process.send({ kind: 'released' }, () => process.disconnect());
      } else if (command === 'exit') {
        process.disconnect();
      } else {
        throw new Error('Unknown fixture command');
      }
    } catch (error) {
      process.send({
        kind: error.name === 'AgentHomeLockedError' ? 'busy' : 'error',
        error: error.message,
      });
    }
  });
  process.send({ kind: 'ready' });
`;

function parseMessage(value: unknown) {
  if (typeof value !== 'object' || value === null || !('kind' in value) || typeof value.kind !== 'string') {
    throw new Error('Invalid lock fixture response.');
  }
  return {
    kind: value.kind,
    pid: 'pid' in value ? value.pid : undefined,
    report: 'report' in value ? value.report : undefined,
    error: 'error' in value ? value.error : undefined,
  };
}

interface LockWorker {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  next(): Promise<ReturnType<typeof parseMessage>>;
}

describe('Agent Home PID lock across real Node processes', () => {
  let home: string;
  const workers: LockWorker[] = [];

  function startWorker(mode = 'lock'): LockWorker {
    const child: ChildProcess = spawn(process.execPath, [
      '--expose-gc', '--import=tsx', '--input-type=module', '--eval', childSource, home, mode,
    ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages: ReturnType<typeof parseMessage>[] = [];
    let stderr = '';
    let pending: {
      resolve: (message: ReturnType<typeof parseMessage>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    } | undefined;
    child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.on('message', value => {
      const message = parseMessage(value);
      if (pending) {
        const current = pending;
        pending = undefined;
        clearTimeout(current.timer);
        current.resolve(message);
      } else messages.push(message);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Lock fixture exited before replying: ${stderr}`));
          pending = undefined;
        }
        resolve(code);
      });
    });
    const worker = {
      child, exited,
      next(): Promise<ReturnType<typeof parseMessage>> {
        const message = messages.shift();
        if (message) return Promise.resolve(message);
        return new Promise((resolve, reject) => {
          pending = {
            resolve, reject,
            timer: setTimeout(() => {
              pending = undefined;
              reject(new Error(`Lock fixture response deadline: ${stderr}`));
            }, 10_000),
          };
        });
      },
    };
    workers.push(worker);
    return worker;
  }

  async function acquire(mode = 'lock') {
    const worker = startWorker(mode);
    expect(await worker.next()).toMatchObject({ kind: 'ready' });
    worker.child.send!('acquire');
    return { worker, result: await worker.next() };
  }

  async function expectBusy() {
    const { worker, result } = await acquire();
    expect(result.kind).toBe('busy');
    worker.child.send!('exit');
    expect(await worker.exited).toBe(0);
  }

  async function release(worker: LockWorker) {
    worker.child.send!('release');
    expect(await worker.next()).toMatchObject({ kind: 'released' });
    expect(await worker.exited).toBe(0);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pid-lock-integration-'));
    await writeFile(join(home, 'config.json'), JSON.stringify({
      agents: { memory: { enabled: false } },
      logger: { minLevel: 'info' },
    }));
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
      await worker.exited;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('admits only one racing process and remains locked after metadata inspection', async () => {
    const pair = [startWorker(), startWorker()];
    for (const worker of pair) expect(await worker.next()).toMatchObject({ kind: 'ready' });
    for (const worker of pair) worker.child.send!('acquire');
    const results = await Promise.all(pair.map(worker => worker.next()));
    expect(results.map(result => result.kind).sort()).toEqual(['acquired', 'busy']);
    const index = results.findIndex(result => result.kind === 'acquired');
    const file = join(home, '.my-agent.pid');
    const record = await readFile(file, 'utf8');
    expect(JSON.parse(record).pid).toBe(results[index]!.pid);
    expect((await stat(file)).size).toBe(Buffer.byteLength(record));
    await expectBusy();
    await release(pair[index]!);
    expect(await readFile(file, 'utf8')).toBe(record);
    pair[1 - index]!.child.send!('exit');
    expect(await pair[1 - index]!.exited).toBe(0);
    const next = await acquire();
    expect(next.result.kind).toBe('acquired');
    await release(next.worker);
  }, 20_000);

  it('restarts after force-kill without removing the retained PID record', async () => {
    const owner = await acquire();
    expect(owner.result.kind).toBe('acquired');
    await expectBusy();
    const file = join(home, '.my-agent.pid');
    const record = await readFile(file, 'utf8');
    owner.worker.child.kill('SIGKILL');
    await owner.worker.exited;
    expect(await readFile(file, 'utf8')).toBe(record);
    const next = await acquire();
    expect(next.result.kind).toBe('acquired');
    await release(next.worker);
  }, 20_000);

  it.each(['runtime', 'incomplete-close', 'failed-retirement'])('handles real Runtime shutdown: %s', async mode => {
    const owner = await acquire(mode);
    expect(owner.result.kind).toBe('acquired');
    if (mode === 'failed-retirement') {
      owner.worker.child.send!('retire');
      expect(await owner.worker.next()).toMatchObject({ kind: 'retired' });
    }
    owner.worker.child.send!('close');
    const closed = await owner.worker.next();
    expect(closed.kind).toBe('closed');
    if (mode === 'incomplete-close' || mode === 'failed-retirement') {
      expect(closed.report).toMatchObject({
        completed: expect.not.arrayContaining(['agentHomeLock']),
        residuals: expect.arrayContaining([expect.objectContaining({ phase: 'agent-home-lock' })]),
      });
      if (mode === 'failed-retirement') {
        expect(closed.report).toMatchObject({
          failed: expect.arrayContaining([
            expect.objectContaining({ message: 'fixture channel stop failed' }),
          ]),
        });
      }
      await expectBusy();
    } else {
      expect(closed.report).toMatchObject({ outcome: 'completed', completed: expect.arrayContaining(['agentHomeLock']) });
      const next = await acquire();
      expect(next.result.kind).toBe('acquired');
      await release(next.worker);
    }
    owner.worker.child.send!('exit');
    expect(await owner.worker.exited).toBe(0);
    const afterExit = await acquire();
    expect(afterExit.result.kind).toBe('acquired');
    await release(afterExit.worker);
  }, 30_000);

  it.each(['clean-startup', 'incomplete-startup'])('handles real failed-startup cleanup: %s', async mode => {
    const owner = await acquire(mode);
    expect(owner.result).toMatchObject({ kind: 'error', error: 'fixture startup failure' });
    if (mode === 'incomplete-startup') await expectBusy();
    else {
      const next = await acquire();
      expect(next.result.kind).toBe('acquired');
      await release(next.worker);
    }
    owner.worker.child.send!('exit');
    expect(await owner.worker.exited).toBe(0);
    const afterExit = await acquire();
    expect(afterExit.result.kind).toBe('acquired');
    await release(afterExit.worker);
  }, 30_000);
});
