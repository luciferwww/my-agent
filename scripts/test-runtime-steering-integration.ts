/**
 * RuntimeApp steering integration test.
 *
 * 验证 v1.0 in-turn steering 路径的端到端不变量：
 *   1. routes busy-session input to steering when steer mode is enabled
 *      busy 期间入站消息进入 steering inbox；runner 通过 getSteeringMessages reader
 *      拉取后得到 { role: 'user', content: text } 形态的消息。
 *   2. drains multiple steering messages in FIFO order and clears the inbox once
 *      多条 steering 入站累积；runner 单次拉取得到全部，inbox 不残留。
 *   3. turn 结束后 steering inbox 被无条件清空，不会泄漏到下一个 turn
 *      第一个 turn 期间入站的 steering 在 turn 结束后被丢弃；新启动的下一个 turn
 *      看到的 inbox 是空的。
 *
 * Usage:
 *   npx tsx scripts/test-runtime-steering-integration.ts
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
import type { ChatMessage } from '../src/adapters/llm/types.js';
import { createLoadedRuntimeUnit, type LoadedRuntimeUnit } from '../src/runtime/runtime-unit.js';
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
  unit: LoadedRuntimeUnit;
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
    unit: createLoadedRuntimeUnit({ registration: {
      id: `builtin-test-channel-${id}`,
      source: 'builtin',
      register(api) {
        api.registerChannel({ id, create: () => channel });
      },
    }, required: false }),
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
  const dir = await mkdtemp(join(tmpdir(), 'runtime-steering-'));
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

async function testBasicSteeringRoute(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const releaseRun = createDeferred<void>();
    let drainedSteering: ChatMessage[] = [];
    const runCalls: RunParams[] = [];

    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      runCalls.push(params);
      await releaseRun.promise;
      drainedSteering = (await params.getSteeringMessages?.()) ?? [];
      return okResult;
    };

    const test = createTestChannel('steer-basic-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [test.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
        runner: { inTurnMessageMode: 'steer' },
      },
      dependencies: {
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      },
    });

    try {
      const firstDispatch = test.dispatch({
        sessionKey: 'main',
        message: 'first',
        clientId: 'client-1',
      });

      await waitFor(() => runCalls.length === 1, { label: 'first turn active' });

      const steerDispatch = test.dispatch({
        sessionKey: 'main',
        message: 'steer now',
        clientId: 'client-2',
      });

      await steerDispatch;
      assert.equal(runCalls.length, 1, 'steering should not start a new turn');

      releaseRun.resolve();
      await firstDispatch;

      assert.deepEqual(
        drainedSteering,
        [{ role: 'user', content: 'steer now' }],
        `drainedSteering should be one user message with content "steer now", got: ${JSON.stringify(drainedSteering)}`,
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

async function testMultipleSteeringMessagesFifo(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const releaseRun = createDeferred<void>();
    const drained: ChatMessage[][] = [];

    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      await releaseRun.promise;
      // 第一次拉取应该得到全部 inbox 消息
      drained.push((await params.getSteeringMessages?.()) ?? []);
      // 第二次拉取应该得到空数组（读后即删）
      drained.push((await params.getSteeringMessages?.()) ?? []);
      return okResult;
    };

    const test = createTestChannel('steer-fifo-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [test.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
        runner: { inTurnMessageMode: 'steer' },
      },
      dependencies: {
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      },
    });

    try {
      const firstDispatch = test.dispatch({
        sessionKey: 'main',
        message: 'first',
        clientId: 'client-1',
      });

      // 顺序灌入三条 steering
      await test.dispatch({ sessionKey: 'main', message: 'steer-1', clientId: 'c' });
      await test.dispatch({ sessionKey: 'main', message: 'steer-2', clientId: 'c' });
      await test.dispatch({ sessionKey: 'main', message: 'steer-3', clientId: 'c' });

      releaseRun.resolve();
      await firstDispatch;

      assert.equal(drained.length, 2, `expected two reader calls, got ${drained.length}`);
      assert.deepEqual(
        drained[0],
        [
          { role: 'user', content: 'steer-1' },
          { role: 'user', content: 'steer-2' },
          { role: 'user', content: 'steer-3' },
        ],
        `first drain should contain all three steering messages in FIFO order, got: ${JSON.stringify(drained[0])}`,
      );
      assert.deepEqual(
        drained[1],
        [],
        `second drain should be empty (read-then-delete), got: ${JSON.stringify(drained[1])}`,
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

async function testSteeringClearedAcrossTurns(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const releaseFirst = createDeferred<void>();
    const drained: ChatMessage[][] = [];
    const runCalls: RunParams[] = [];

    let callIndex = 0;
    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      runCalls.push(params);
      const idx = callIndex++;
      if (idx === 0) {
        await releaseFirst.promise;
        // 第一个 turn：不去 drain steering（模拟"runner 没有及时消费"）
        return okResult;
      }
      // 第二个 turn：尝试 drain，应该得到空（前一 turn 残留已被清理）
      drained.push((await params.getSteeringMessages?.()) ?? []);
      return okResult;
    };

    const test = createTestChannel('steer-cleanup-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [test.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
        runner: { inTurnMessageMode: 'steer' },
      },
      dependencies: {
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      },
    });

    try {
      // 启动第一个 turn 并灌入一条未消费的 steering
      const firstDispatch = test.dispatch({
        sessionKey: 'main',
        message: 'first',
        clientId: 'client-1',
      });
      await waitFor(() => runCalls.length === 1, { label: 'first turn active' });
      await test.dispatch({ sessionKey: 'main', message: 'orphan steer', clientId: 'c' });

      releaseFirst.resolve();
      await firstDispatch;

      // 第二个 turn：steering inbox 应该已被 turn-end finally 清空
      const secondDispatch = test.dispatch({
        sessionKey: 'main',
        message: 'second',
        clientId: 'client-1',
      });
      await secondDispatch;
      await waitFor(() => runCalls.length === 2, { label: 'second turn run completed' });

      assert.equal(drained.length, 1, `second turn should have invoked drain once, got ${drained.length}`);
      assert.deepEqual(
        drained[0],
        [],
        `orphan steering from previous turn should not leak; got: ${JSON.stringify(drained[0])}`,
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RuntimeApp Steering Integration Tests ===');

  await runStep(
    'routes busy-session input to steering inbox under steer mode',
    testBasicSteeringRoute,
  );
  await runStep(
    'drains multiple steering messages in FIFO order with read-then-delete semantics',
    testMultipleSteeringMessagesFifo,
  );
  await runStep(
    'clears steering inbox at turn end so it does not leak into the next turn',
    testSteeringClearedAcrossTurns,
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
