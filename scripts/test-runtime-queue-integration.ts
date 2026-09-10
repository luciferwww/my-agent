/**
 * RuntimeApp inbound queue integration test.
 *
 * 验证 v1.0 的 per-session 串行 / 跨 session 并发 / 'steer' 模式无活动 turn
 * 时退化到普通队列等关键不变量。所有测试都通过 channel.onMessage 入站触发，
 * 不直接调用 app.runTurn，以确保队列调度路径真正被覆盖。
 *
 * 用例：
 *   1. queues busy-session messages and runs them serially: 同 session 第二条消息
 *      在第一条 busy 时进入队列；第一条完成后第二条自动启动；launchContext 透传。
 *   2. dispatches different sessions concurrently: 两条消息分属不同 sessionKey，
 *      runner 端可同时观察到两次进行中的调用。
 *   3. steer mode without active turn falls back to normal queue: config='steer'
 *      但无活动 turn 时，第一条入站消息也走普通队列、立刻启动新 turn。
 *
 * Usage:
 *   npx tsx scripts/test-runtime-queue-integration.ts
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
} from '../src/core/channel/index.js';
import type { ChatMessage } from '../src/core/model-invocation/index.js';
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
  const dir = await mkdtemp(join(tmpdir(), 'runtime-queue-'));
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

async function testPerSessionSerial(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const firstRun = createDeferred<RunResult>();
    const runCalls: RunParams[] = [];

    let callIndex = 0;
    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      runCalls.push(params);
      const idx = callIndex++;
      if (idx === 0) return firstRun.promise;
      return {
        text: 'second',
        content: [{ type: 'text', text: 'second' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    };

    const test = createTestChannel('queue-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [test.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
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

      await waitFor(() => runCalls.length === 1, { label: 'first run started' });

      const secondDispatch = test.dispatch({
        sessionKey: 'main',
        message: 'second',
        clientId: 'client-1',
        maxLlmCalls: 9,
      });

      await secondDispatch;
      assert.equal(
        runCalls.length,
        1,
        `runner should still be on first call while second is queued, got ${runCalls.length}`,
      );

      firstRun.resolve({
        text: 'first',
        content: [{ type: 'text', text: 'first' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

      await firstDispatch;
      await waitFor(() => runCalls.length === 2, { label: 'second run started' });

      assert.equal(runCalls[0]?.message, 'first', 'first run message');
      assert.equal(runCalls[1]?.message, 'second', 'second run message');
      assert.equal(
        runCalls[1]?.maxLlmCalls,
        9,
        `launchContext.maxLlmCalls should propagate; got ${runCalls[1]?.maxLlmCalls}`,
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

async function testCrossSessionConcurrency(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const releaseA = createDeferred<void>();
    const releaseB = createDeferred<void>();
    const activeSessions = new Set<string>();
    const peakConcurrency = { value: 0 };

    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      activeSessions.add(params.sessionKey);
      peakConcurrency.value = Math.max(peakConcurrency.value, activeSessions.size);
      try {
        if (params.sessionKey === 'session-a') await releaseA.promise;
        else if (params.sessionKey === 'session-b') await releaseB.promise;
        return okResult;
      } finally {
        activeSessions.delete(params.sessionKey);
      }
    };

    const test = createTestChannel('concurrency-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [test.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'claude-sonnet-5' },
        memory: { enabled: false },
      },
      dependencies: {
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      },
    });

    try {
      const dispatchA = test.dispatch({
        sessionKey: 'session-a',
        message: 'A',
        clientId: 'client-a',
      });
      const dispatchB = test.dispatch({
        sessionKey: 'session-b',
        message: 'B',
        clientId: 'client-b',
      });

      await waitFor(
        () => activeSessions.has('session-a') && activeSessions.has('session-b'),
        { label: 'both sessions active concurrently' },
      );

      assert.equal(
        peakConcurrency.value,
        2,
        `peak concurrency across different sessions should be 2, got ${peakConcurrency.value}`,
      );

      releaseA.resolve();
      releaseB.resolve();
      await Promise.all([dispatchA, dispatchB]);
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

async function testSteerModeWithoutActiveTurnFallsBack(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const runCalls: RunParams[] = [];
    let drainedSteering: ChatMessage[] = [];

    const runnerRun = async (params: RunParams): Promise<RunResult> => {
      runCalls.push(params);
      // 立刻拉一次 steering：应该是空的，因为首条消息走的是普通队列
      drainedSteering = (await params.getSteeringMessages?.()) ?? [];
      return okResult;
    };

    const test = createTestChannel('steer-no-active-test');
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
      // session 上无活动 turn，即使 mode='steer'，消息也应进入普通队列并启动新 turn
      await test.dispatch({
        sessionKey: 'main',
        message: 'first message under steer mode',
        clientId: 'client-1',
      });

      await waitFor(() => runCalls.length === 1, { label: 'turn started' });

      assert.equal(runCalls.length, 1, 'one turn should be started');
      assert.equal(
        runCalls[0]?.message,
        'first message under steer mode',
        'first message should be the original inbound message, not steering content',
      );
      assert.equal(
        drainedSteering.length,
        0,
        `steering inbox should be empty (got ${drainedSteering.length} entries)`,
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RuntimeApp Queue Integration Tests ===');

  await runStep(
    'queues busy-session channel messages and runs them serially with launchContext propagation',
    testPerSessionSerial,
  );
  await runStep(
    'dispatches inbound messages on different sessionKeys concurrently',
    testCrossSessionConcurrency,
  );
  await runStep(
    'falls back to normal queue when steer mode is enabled but no turn is active',
    testSteerModeWithoutActiveTurnFallsBack,
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
