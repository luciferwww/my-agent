/**
 * RuntimeApp multi-channel integration test.
 *
 * 覆盖 WebSocket channel 端到端 + 多 channel fanout + onAgentEvent observer 三大场景：
 *
 *   1. queued WebSocket approvals route back to the queued turn's origin client
 *      （从原 RuntimeApp.integration.test.ts 迁移）
 *      - 两个 WS 客户端各发一条 run_turn；第二条在第一条 busy 时排队；
 *      - 第一条结束后第二条启动；第二条 turn 内触发 approval；
 *      - approval_requested 必须只发给第二条 turn 的 origin（client-2），不能发给 client-1；
 *      - client-2 回 approval_resolve → 第二个 run 收到 allow 决策。
 *
 *   2. queued WebSocket approval stays pending and Abort closes it at the queued turn's origin
 *      （从原 RuntimeApp.integration.test.ts 迁移）
 *      - 同上，但 channel 不回 approval_resolve；
 *      - 短窗口内没有自动结束；Turn Abort 后 approval_closed 必须只发给 client-2。
 *
 *   3. fanout forwards every AgentEvent to every registered channel and onAgentEvent observer
 *      - 注册两个普通 channel；runner stub 主动 emit run_start/run_end；
 *      - 两个 channel 的 send 都被按序调用；onAgentEvent observer 也按序收到。
 *
 * Usage:
 *   npx tsx scripts/test-runtime-multichannel-integration.ts
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { WebSocket } from 'ws';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import { WebSocketChannel } from '../src/adapters/channel/WebSocketChannel.js';
import type {
  Channel,
  ChannelRunRequest,
} from '../src/adapters/channel/types.js';
import type { AgentEvent, BeforeToolCallHook } from '../src/core/runner/index.js';
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = opts;
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
  const dir = await mkdtemp(join(tmpdir(), 'runtime-multichannel-'));
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

// ── WebSocket helpers (parity with old RuntimeApp.integration.test.ts) ─────

async function connectClient(
  channel: WebSocketChannel,
  clients: WebSocket[],
): Promise<WebSocket> {
  const address = (channel as unknown as { server?: { address(): unknown } }).server?.address();
  if (!address || typeof address !== 'object' || !('port' in address)) {
    throw new Error('WebSocketChannel server address is not available');
  }
  const client = new WebSocket(`ws://127.0.0.1:${(address as { port: number }).port}/ws`);
  clients.push(client);
  await once(client, 'open');
  return client;
}

async function readMessage(client: WebSocket): Promise<Record<string, unknown>> {
  const [raw] = await once(client, 'message');
  return JSON.parse((raw as Buffer).toString('utf-8')) as Record<string, unknown>;
}

async function expectMessage(
  client: WebSocket,
  match: (msg: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const msg = await readMessage(client);
  match(msg);
  return msg;
}

async function expectNoMessage(client: WebSocket, timeoutMs: number): Promise<void> {
  const message = await Promise.race([
    once(client, 'message').then(([raw]) =>
      JSON.parse((raw as Buffer).toString('utf-8')) as Record<string, unknown>,
    ),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  assert.equal(message, null, `expected no message within ${timeoutMs}ms; got: ${JSON.stringify(message)}`);
}

// ── 收集 channel 调用的 helper ─────────────────────────────────

type RecordingChannel = {
  channel: Channel;
  sentEvents: AgentEvent[];
};

function createRecordingChannel(id: string): RecordingChannel {
  const sentEvents: AgentEvent[] = [];
  const channel: Channel = {
    id,
    send(event) {
      sentEvents.push(event);
    },
    onMessage() {},
    async start() {},
    async stop() {},
  };
  return { channel, sentEvents };
}

// ── 测试用例 ────────────────────────────────────────────────────

async function testQueuedWebSocketApprovalRoutesToQueuedOrigin(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const clients: WebSocket[] = [];
    let app: RuntimeApp | undefined;
    let channel: WebSocketChannel | undefined;

    try {
      const firstRun = createDeferred<RunResult>();
      const secondRunFinished = createDeferred<void>();
      let beforeToolCallHook: BeforeToolCallHook | undefined;
      let runCount = 0;
      let secondDecision: unknown;

      const runnerRun = async (params: RunParams): Promise<RunResult> => {
        runCount++;
        if (runCount === 1) return firstRun.promise;
        try {
          secondDecision = await beforeToolCallHook?.({
            toolName: 'demo_tool',
            input: { approval: true },
            turnId: params.turnId,
            sessionKey: params.sessionKey,
            signal: params.signal,
          });
          return {
            text: 'second',
            content: [{ type: 'text', text: 'second' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
            toolRounds: 0,
          };
        } finally {
          secondRunFinished.resolve();
        }
      };

      const agentRunner = {
        setToolExecutor() {},
        on(hookName: string, handler: BeforeToolCallHook) {
          if (hookName === 'before_tool_call') beforeToolCallHook = handler;
          return agentRunner;
        },
        run: runnerRun,
      };

      app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
        },
        dependencies: {
          createAgentRunner: () => agentRunner as never,
          createMemoryManager: async () => null,
        },
      });

      channel = new WebSocketChannel({ port: 0, approval: true });
      app.registerChannel(channel);
      await app.startChannels();

      const client1 = await connectClient(channel, clients);
      client1.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
      await expectMessage(client1, (msg) => {
        assert.equal(msg.type, 'hello_ack');
        assert.equal(msg.clientId, 'client-1');
      });

      const client2 = await connectClient(channel, clients);
      client2.send(JSON.stringify({ type: 'hello', clientId: 'client-2' }));
      await expectMessage(client2, (msg) => {
        assert.equal(msg.type, 'hello_ack');
        assert.equal(msg.clientId, 'client-2');
      });

      client1.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'first' }));
      await waitFor(() => runCount === 1, { label: 'first run started' });

      client2.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'second' }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(runCount, 1, 'second run must be queued, not started');

      firstRun.resolve({
        text: 'first',
        content: [{ type: 'text', text: 'first' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

      const approvalReq = await readMessage(client2);
      assert.equal(approvalReq.type, 'approval_requested', `expected approval_requested on client2, got: ${JSON.stringify(approvalReq)}`);
      assert.equal(approvalReq.toolName, 'demo_tool');
      assert.deepEqual(approvalReq.input, { approval: true });

      await expectNoMessage(client1, 100);

      client2.send(JSON.stringify({
        type: 'approval_resolve',
        id: approvalReq.id,
        decision: 'allow',
      }));

      await secondRunFinished.promise;
      assert.equal(runCount, 2, `expected exactly 2 runs, got ${runCount}`);
      assert.deepEqual(secondDecision, { action: 'allow' }, `expected allow decision; got: ${JSON.stringify(secondDecision)}`);
    } finally {
      for (const c of clients.splice(0)) c.close();
      await app?.close('test complete').catch(() => undefined);
      await channel?.stop().catch(() => undefined);
    }
  });
}

async function testQueuedWebSocketApprovalAbortRoutesToQueuedOrigin(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const clients: WebSocket[] = [];
    let app: RuntimeApp | undefined;
    let channel: WebSocketChannel | undefined;

    try {
      const firstRun = createDeferred<RunResult>();
      const secondRunFinished = createDeferred<void>();
      let beforeToolCallHook: BeforeToolCallHook | undefined;
      let runCount = 0;
      let secondDecision: unknown;

      const runnerRun = async (params: RunParams): Promise<RunResult> => {
        runCount++;
        if (runCount === 1) return firstRun.promise;
        try {
          secondDecision = await beforeToolCallHook?.({
            toolName: 'demo_tool',
            input: { approval: true },
            turnId: params.turnId,
            sessionKey: params.sessionKey,
            signal: params.signal,
          });
          return {
            text: 'approved',
            content: [{ type: 'text', text: 'approved' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
            toolRounds: 0,
          };
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error;
          secondDecision = 'aborted';
          return {
            text: '',
            content: [],
            stopReason: 'aborted',
            usage: { inputTokens: 0, outputTokens: 0 },
            toolRounds: 0,
          };
        } finally {
          secondRunFinished.resolve();
        }
      };

      const agentRunner = {
        setToolExecutor() {},
        on(hookName: string, handler: BeforeToolCallHook) {
          if (hookName === 'before_tool_call') beforeToolCallHook = handler;
          return agentRunner;
        },
        run: runnerRun,
      };

      app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
        },
        dependencies: {
          createAgentRunner: () => agentRunner as never,
          createMemoryManager: async () => null,
        },
      });

      channel = new WebSocketChannel({ port: 0, approval: true });
      app.registerChannel(channel);
      await app.startChannels();

      const client1 = await connectClient(channel, clients);
      client1.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
      await expectMessage(client1, (msg) => {
        assert.equal(msg.type, 'hello_ack');
        assert.equal(msg.clientId, 'client-1');
      });

      const client2 = await connectClient(channel, clients);
      client2.send(JSON.stringify({ type: 'hello', clientId: 'client-2' }));
      await expectMessage(client2, (msg) => {
        assert.equal(msg.type, 'hello_ack');
        assert.equal(msg.clientId, 'client-2');
      });

      client1.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'first' }));
      await waitFor(() => runCount === 1, { label: 'first run started' });

      client2.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'second' }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(runCount, 1, 'second run must be queued, not started');

      firstRun.resolve({
        text: 'first',
        content: [{ type: 'text', text: 'first' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

      const approvalReq = await readMessage(client2);
      assert.equal(approvalReq.type, 'approval_requested', `expected approval_requested on client2, got: ${JSON.stringify(approvalReq)}`);

      await expectNoMessage(client2, 200);
      assert.equal(secondDecision, undefined, 'approval must remain pending without a response');

      assert.deepEqual(app.abortTurn('main'), { aborted: true, dropped: 0 });
      const closed = await readMessage(client2);
      assert.deepEqual(closed, {
        type: 'approval_closed',
        id: approvalReq.id,
        outcome: 'aborted',
        reason: 'turn',
      });

      await expectNoMessage(client1, 50);
      await secondRunFinished.promise;
      assert.equal(secondDecision, 'aborted');
    } finally {
      for (const c of clients.splice(0)) c.close();
      await app?.close('test complete').catch(() => undefined);
      await channel?.stop().catch(() => undefined);
    }
  });
}

async function testFanoutForwardsAgentEventsToAllChannelsAndObserver(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const observerEvents: AgentEvent[] = [];
    let runnerEmit: ((e: AgentEvent) => void) | undefined;

    // runner stub：通过 bootstrap 传入的 onEvent（其实是 RuntimeApp 的 fanout）emit 两条事件
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createAgentRunner: (config: { onEvent?: (e: AgentEvent) => void }) => {
          runnerEmit = config.onEvent;
          return {
            setToolExecutor() {},
            run: async (params: RunParams): Promise<RunResult> => {
              runnerEmit?.({
                type: 'run_start',
                sessionKey: params.sessionKey,
                turnId: params.turnId,
              });
              runnerEmit?.({
                type: 'run_end',
                sessionKey: params.sessionKey,
                turnId: params.turnId,
                result: okResult,
              });
              return okResult;
            },
          } as never;
        },
        createMemoryManager: async () => null,
      },
      onAgentEvent: (event) => observerEvents.push(event),
    });

    try {
      const a = createRecordingChannel('fanout-a');
      const b = createRecordingChannel('fanout-b');
      app.registerChannel(a.channel);
      app.registerChannel(b.channel);

      await app.runTurn({ sessionKey: 'main', message: 'trigger fanout', promptMode: 'full' });

      const aTypes = a.sentEvents.map((e) => e.type);
      const bTypes = b.sentEvents.map((e) => e.type);
      assert.deepEqual(
        aTypes,
        ['run_start', 'run_end'],
        `channel A should receive both events in order, got: ${JSON.stringify(aTypes)}`,
      );
      assert.deepEqual(
        bTypes,
        ['run_start', 'run_end'],
        `channel B should receive both events in order, got: ${JSON.stringify(bTypes)}`,
      );
      assert.deepEqual(
        observerEvents.map((e) => e.type),
        ['run_start', 'run_end'],
        `observer should receive both events; got: ${JSON.stringify(observerEvents.map((e) => e.type))}`,
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RuntimeApp Multi-channel Integration Tests ===');

  await runStep(
    'routes queued websocket approval back to the queued turn\'s origin client',
    testQueuedWebSocketApprovalRoutesToQueuedOrigin,
  );
  await runStep(
    'keeps queued websocket approval pending until Abort closes it at the queued turn\'s origin client',
    testQueuedWebSocketApprovalAbortRoutesToQueuedOrigin,
  );
  await runStep(
    'fanout forwards each AgentEvent to every registered channel and the onAgentEvent observer',
    testFanoutForwardsAgentEventsToAllChannelsAndObserver,
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
