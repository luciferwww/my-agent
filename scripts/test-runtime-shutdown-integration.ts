/**
 * RuntimeApp shutdown integration test.
 *
 * 验证 v1.0 关停语义在 in-flight / 队列 / 复用入口三个维度的不变量：
 *
 *   1. close() waits for in-flight runs: 进行中的 turn 没结束之前，close() 不能 resolve。
 *   2. queued messages do not start after close: close() 进行中（phase=closing）时，
 *      原本排在队列尾部、还未启动的 turn 不会再被调度起来（runtime 拒绝新运行）。
 *   3. close() rejects subsequent runTurn calls: shutdown 之后 app.runTurn() 抛 RUN_REJECTED。
 *
 * Usage:
 *   npx tsx scripts/test-runtime-shutdown-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type {
  Channel,
  ChannelCompletion,
  ChannelRunRequest,
} from '../src/adapters/channel/types.js';
import type { RuntimeContributionUnit } from '../src/core/registry/index.js';
import type { RunParams, RunResult } from '../src/core/runner/types.js';

// ── runStep 脚手架 ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runStep(name: string, step: () => Promise<void>): Promise<void> {
  console.log(`\n${'-'.repeat(72)}`);
  console.log(`STEP: ${name}`);
  console.log('-'.repeat(72));
  try {
    await step();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAILED: ${name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

// ── 测试基础工具 ────────────────────────────────────────────────

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestChannel(id: string): {
  channel: Channel;
  unit: RuntimeContributionUnit;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  const completion = createDeferred<ChannelCompletion>();
  const channel: Channel = {
    id,
    completion: completion.promise,
    send() {},
    onMessage(nextHandler) {
      handler = nextHandler;
    },
    async start() {},
    async stop() {
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    },
  };
  return {
    channel,
    unit: {
      id: `builtin-test-channel-${id}`,
      source: 'builtin',
      register(api) {
        api.registerChannel({ id, create: () => channel });
      },
    },
    async dispatch(req: ChannelRunRequest) {
      if (!handler) throw new Error('message handler was not registered');
      await handler(req);
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 2000, intervalMs = 5, label = 'condition' } = opts;
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-shutdown-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const okResult: RunResult = {
  text: 'ok',
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
  toolRounds: 0,
};

// ── 测试用例 ────────────────────────────────────────────────────

async function testCloseWaitsForInFlight(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const release = createDeferred<void>();
    let runFinished = false;

    const runnerRun = async (_params: RunParams): Promise<RunResult> => {
      await release.promise;
      runFinished = true;
      return okResult;
    };

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
      },
      dependencies: {
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      },
    });

    const turnPromise = app.application.runTurn({ sessionKey: 'main', message: 'long running', promptMode: 'full' });
    // 等 runner 真正进入等待
    await waitFor(() => app.application.getState().activeRunCount === 1, {
      label: 'runner active',
    });

    let closeResolved = false;
    const closePromise = app
      .close('test shutdown')
      .then((r) => {
        closeResolved = true;
        return r;
      })
      .catch((err) => {
        closeResolved = true;
        throw err;
      });

    // 给 close() 一段时间真的"挂着"
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      closeResolved,
      false,
      'close() must not resolve while a turn is still in flight',
    );
    assert.equal(
      runFinished,
      false,
      'in-flight turn should not have completed yet',
    );

    release.resolve();
    await turnPromise;
    await closePromise;

    assert.equal(runFinished, true, 'turn should have finished');
    assert.equal(app.application.getState().phase, 'closed', 'phase should be "closed"');
  });
}

async function testQueuedMessagesDoNotStartAfterClose(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const release = createDeferred<void>();
    const runCalls: string[] = [];

    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      assert.equal(typeof params.message, 'string');
      if (typeof params.message !== 'string') throw new Error('expected text message');
      runCalls.push(params.message);
      if (runCalls.length === 1) await release.promise;
      return okResult;
    };

    const test = createTestChannel('shutdown-queue-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      contributionUnits: [test.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
      },
      dependencies: {
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      },
    });

    // 第一条消息：进入 in-flight，等 release
    const firstDispatch = test.dispatch({
      sessionKey: 'main',
      message: 'first',
      clientId: 'client-1',
    });
    await waitFor(() => runCalls.length === 1, { label: 'first turn active' });

    // 第二条消息：进入队列尾部，等第一条结束后才会被调度
    await test.dispatch({
      sessionKey: 'main',
      message: 'second',
      clientId: 'client-1',
    });
    assert.equal(runCalls.length, 1, 'second message must be queued, not started');

    // 在第一条 turn 仍 in-flight 时启动 close（phase → closing）
    const closePromise = app.close('test shutdown');

    // 释放第一条；当其 finally 尝试调度第二条时，phase=closing 会让 assertCanRunForSession 拒绝
    release.resolve();
    await firstDispatch;
    await closePromise;

    assert.equal(
      runCalls.length,
      1,
      `queued "second" message should be dropped after close; got ${runCalls.length} runs`,
    );
    assert.equal(runCalls[0], 'first', 'only the in-flight first message should have run');
  });
}

async function testRunTurnRejectedAfterClose(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
      },
      dependencies: {
        createAgentRunner: () => ({
          run: async (): Promise<RunResult> => okResult,
        }) as never,
        createMemoryManager: async () => null,
      },
    });

    await app.close('test shutdown');

    let err: unknown;
    try {
      await app.application.runTurn({ sessionKey: 'main', message: 'after close', promptMode: 'full' });
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof Error, 'runTurn after close should throw');
    assert.match(
      (err as Error).message,
      /Cannot run when runtime phase is closed\./,
      `error message should mention phase=closed; got: ${(err as Error).message}`,
    );
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RuntimeApp Shutdown Integration Tests ===');

  await runStep(
    'close() awaits in-flight turns before resolving',
    testCloseWaitsForInFlight,
  );
  await runStep(
    'close() drops queued messages that were not yet running',
    testQueuedMessagesDoNotStartAfterClose,
  );
  await runStep(
    'runTurn() throws RUN_REJECTED after the runtime is closed',
    testRunTurnRejectedAfterClose,
  );

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
