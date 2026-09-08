/**
 * End-to-end abort demo (manual test, not part of vitest).
 *
 * Exercises the full abort stack from PR-1 through PR-7 against a mock
 * LLM that respects `AbortSignal` between yielded stream events. Runs
 * offline; no API key required.
 *
 * Scenarios (matches core-abort-spec.md §14.2):
 *   1. abort mid-stream → RunResult.stopReason='aborted' + partial usage
 *      preserved + partial text captured + assistant record on disk carries
 *      abortMeta.
 *   2. orphan tool_use repair on the next turn — pre-seed a partial
 *      assistant with an unmatched tool_use, then start a fresh turn and
 *      assert `orphan_tool_results_repaired` fires and a synthetic
 *      `[tool call interrupted; session recovered]` toolResult was
 *      appended.
 *   3. messages_dropped runtime event when abort with a non-empty queue.
 *   4. shutdown aborts in-flight turns (close() abort-then-wait path,
 *      spec §8.5).
 *
 * Usage:
 *   npx tsx scripts/test-abort-e2e.ts
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type { RuntimeApplication } from '../src/runtime/runtime-composition.js';
import { SessionManager } from '../src/core/session/index.js';
import type { Channel, ChannelCompletion, ChannelRunRequest } from '../src/adapters/channel/types.js';
import { createLoadedRuntimeUnit } from '../src/runtime/runtime-unit.js';
import type {
  ChatParams,
  ChatResponse,
  LLMClient,
  StreamEvent,
} from '../src/adapters/llm/types.js';
import type { AgentEvent } from '../src/core/runner/index.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

// ── runStep harness ─────────────────────────────────────────

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

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'abort-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeAgentDir(workspaceDir: string): Promise<void> {
  const agentDir = join(workspaceDir, '.agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'config.json'),
    JSON.stringify(
      { agents: { defaults: { llm: { apiKey: 'x', model: 'mock' }, memory: { enabled: false } } } },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity\nAbort e2e agent.', 'utf-8');
}

// ── Signal-aware mock LLM ───────────────────────────────────

/**
 * A mock LLM stream that yields scripted events with a small cooperative
 * delay between each. The delay awaits `params.signal.abort` so the
 * outer test can flip abort at any point and the SDK-equivalent
 * `AbortError` is thrown mid-iteration — mirroring what
 * `@anthropic-ai/sdk` does inside a real stream.
 *
 * `perCallEvents` lets a single test drive multiple sequential LLM calls
 * (e.g. tool_use round + follow-up).
 */
function createSignalAwareLLM(perCallEvents: StreamEvent[][], delayMs = 25): {
  client: LLMClient;
  callCount: () => number;
} {
  let call = 0;
  const client: LLMClient = {
    async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
      const events = perCallEvents[call] ?? perCallEvents[perCallEvents.length - 1];
      call += 1;
      if (!events) throw new Error(`mock LLM: no scripted events for call #${call}`);

      for (const ev of events) {
        // Cooperative pause + signal check. Real SDK aborts mid-network-read;
        // the AbortError shape must match what `AgentRunner.isAbortError`
        // recognises (name === 'AbortError' or 'APIUserAbortError').
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          if (!params.signal) return;
          if (params.signal.aborted) {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          params.signal.addEventListener('abort', onAbort, { once: true });
        });

        yield ev;
      }
    },
    async chat(): Promise<ChatResponse> {
      throw new Error('non-stream chat not used by AgentRunner');
    },
  };
  return { client, callCount: () => call };
}

function createTestProvider(client: LLMClient) {
  return [{
    id: 'test',
    protocol: 'test',
    invocationPort: client,
    resolveConnection: () => ({ ok: true as const, connection: { endpointId: 'test' } }),
    resolveModel: (modelId: string, connection: { endpointId: string }) => ({
      ok: true as const,
      descriptor: {
        identity: { providerId: 'test', modelId },
        protocol: 'test',
        connection,
        facts: {
          effectiveContextLimit: { value: 200_000, source: 'deployment-config' as const },
          maximumOutputTokens: { value: 8192, source: 'deployment-config' as const },
          toolUse: { value: true, source: 'deployment-config' as const },
        },
      },
    }),
  }];
}

function createTestChannel(id: string) {
  let handler: ((request: ChannelRunRequest) => Promise<void>) | undefined;
  let complete!: (completion: ChannelCompletion) => void;
  const completion = new Promise<ChannelCompletion>((resolve) => { complete = resolve; });
  const channel: Channel = {
    id,
    completion,
    send() {},
    onMessage(next) { handler = next; },
    async start() {},
    async stop() { complete({ outcome: 'closed', reason: 'stopped' }); },
  };
  return {
    unit: createLoadedRuntimeUnit({
      registration: {
        id: `abort-test-${id}`,
        source: 'builtin',
        register(api) { api.registerChannel({ id, create: () => channel }); },
      },
      required: false,
    }),
    dispatch(request: ChannelRunRequest) {
      if (!handler) throw new Error('Channel ingress is not ready.');
      return handler(request);
    },
  };
}

// ── Scenario 1: abort mid-stream ────────────────────────────

async function scenarioAbortMidStream(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    await writeAgentDir(workspaceDir);

    // Long enough scripted stream that abort after the FIRST text_delta
    // leaves several unemitted events. Usage on message_end would give
    // 100/50 in the happy path; abort should preserve accumulated usage
    // from stream_start onwards (which for mid-stream abort is 0 until
    // message_end fires — see AgentRunner.buildAbortedResult).
    const { client } = createSignalAwareLLM([[
      { type: 'message_start' },
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'from ' },
      { type: 'text_delta', text: 'mock ' },
      { type: 'text_delta', text: 'LLM. ' },
      { type: 'text_delta', text: 'Final.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } },
    ]]);

    const agentEvents: AgentEvent[] = [];
    const sk = 'main';

    // Fire abort as soon as we see the first text_delta on the wire.
    // Timing is naturally racy (delayMs=25 gives a comfortable window)
    // but the signal check happens BEFORE each yield so at least one
    // event must have been emitted before abort takes effect.
    let firedAbort = false;
    let appRef: RuntimeApplication | undefined;
    let sessionManager!: SessionManager;
    const observer = (e: AgentEvent) => {
      agentEvents.push(e);
      if (!firedAbort && e.type === 'text_delta') {
        firedAbort = true;
        appRef!.abortTurn(sk);
      }
    };

    const app = await RuntimeApp.create({
      workspaceDir,
      onAgentEvent: observer,
      dependencies: {
        createProviderProjection: () => createTestProvider(client),
        createSessionManager: (dir, options) => {
          sessionManager = new SessionManager(dir, options);
          return sessionManager;
        },
      },
    });
    appRef = app.application;

    try {
      const result = await app.application.runTurn({
        sessionKey: sk,
        message: 'please respond',
        promptMode: 'full',
      });

      console.log('  result.stopReason =', result.stopReason);
      console.log('  result.text       =', JSON.stringify(result.text));
      console.log('  result.usage      =', result.usage);
      console.log('  agent events      =', agentEvents.map((e) => e.type).join(' → '));

      assert.equal(result.stopReason, 'aborted', 'top-level stopReason must be aborted');
      assert.ok(firedAbort, 'observer should have fired abort on first text_delta');
      // Partial text: at LEAST the first chunk should have accumulated
      // before abort fired. Exact content is racy; assert the invariant.
      assert.ok(
        result.text.startsWith('Hello '),
        `partial text should start with the first chunk; got ${JSON.stringify(result.text)}`,
      );
      assert.ok(!result.text.includes('Final.'), 'final chunk must NOT be in aborted result');
      // Usage: mid-stream abort before message_end fires means no
      // final usage was recorded on this call; accumulated is {0,0}
      // per AgentRunner.buildAbortedResult(). This is the documented
      // v1 contract (spec §8.4) — real SDK usage can only be trusted
      // from message_end.
      assert.equal(result.usage.inputTokens, 0, 'usage.inputTokens accumulated is 0 (message_end never fired)');
      assert.equal(result.usage.outputTokens, 0, 'usage.outputTokens accumulated is 0 (message_end never fired)');

      // Assert session state: last assistant record must carry abortMeta.
      const records = sessionManager.getMessages(sk);
      const lastAssistant = [...records].reverse().find((r) => r.message.role === 'assistant');
      assert.ok(lastAssistant, 'a partial assistant record must be written');
      assert.deepEqual(
        lastAssistant!.message.abortMeta,
        { partial: true, stopReason: 'aborted' },
        'assistant record must carry abortMeta',
      );
      console.log('  session partial assistant.abortMeta =', lastAssistant!.message.abortMeta);
    } finally {
      await app.close('scenario 1 done').catch(() => undefined);
    }
  });
}

// ── Scenario 2: orphan tool_use repair on next turn ─────────

async function scenarioOrphanRepair(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    await writeAgentDir(workspaceDir);

    // Next turn's LLM call: plain text response.
    const { client } = createSignalAwareLLM([[
      { type: 'message_start' },
      { type: 'text_delta', text: 'ok, continuing' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5 } },
    ]]);

    const agentEvents: AgentEvent[] = [];
    let sessionManager!: SessionManager;

    const app = await RuntimeApp.create({
      workspaceDir,
      onAgentEvent: (e) => agentEvents.push(e),
      dependencies: {
        createProviderProjection: () => createTestProvider(client),
        createSessionManager: (dir, options) => {
          sessionManager = new SessionManager(dir, options);
          return sessionManager;
        },
      },
    });

    const sk = 'main';

    // Pre-seed a partial assistant with an unmatched tool_use. Mirrors
    // the shape AgentRunner leaves on disk after an abort during tool
    // execution (spec §7.2). We reach into resources.sessionManager for
    // direct write access; this is a script boundary, not a public API.
    await sessionManager.resolveSession(sk);
    await sessionManager.appendMessage(sk, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'orphan-tu-1', name: 'read_file', input: { path: '/nope' } }],
      abortMeta: { partial: true, stopReason: 'aborted' },
    });

    try {
      const result = await app.application.runTurn({
        sessionKey: sk,
        message: 'continue please',
        promptMode: 'full',
      });

      console.log('  result.stopReason =', result.stopReason);
      console.log('  result.text       =', JSON.stringify(result.text));

      assert.equal(result.stopReason, 'end_turn', 'next turn should complete normally');

      const repair = agentEvents.find((e) => e.type === 'orphan_tool_results_repaired');
      console.log('  repair event      =', repair);
      assert.ok(repair, 'orphan_tool_results_repaired event must fire');
      // Repair source: 'abort' when the orphan carries abortMeta,
      // 'recovered' otherwise (spec §7.2 orphan classification).
      assert.equal(
        (repair as { source: string }).source,
        'abort',
        'source should be "abort" because we seeded abortMeta',
      );
      assert.equal((repair as { count: number }).count, 1, 'exactly one orphan repaired');

      const records = sessionManager.getMessages(sk);
      const toolResult = records.find((r) => r.message.role === 'toolResult');
      assert.ok(toolResult, 'a synthetic toolResult record must be appended');
      const trBlocks = toolResult!.message.content as Array<{
        type: string;
        tool_use_id: string;
        content: string;
      }>;
      assert.equal(trBlocks[0]!.tool_use_id, 'orphan-tu-1', 'synthetic tool_use_id matches the orphan');
      assert.equal(
        trBlocks[0]!.content,
        '[tool call interrupted; session recovered]',
        'synthetic content is the openclaw-aligned unified message',
      );
      console.log('  synthetic toolResult =', trBlocks[0]);
    } finally {
      await app.close('scenario 2 done').catch(() => undefined);
    }
  });
}

// ── Scenario 3: messages_dropped on queue abort ─────────────

async function scenarioMessagesDropped(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    await writeAgentDir(workspaceDir);

    // Turn 1: slow enough that we can enqueue several followups while
    // it's still running, then abort.
    const { client } = createSignalAwareLLM(
      [[
        { type: 'message_start' },
        { type: 'text_delta', text: 'thinking...' },
        // No message_end within the window; we abort before it fires.
      ]],
      // Larger delay so the enqueue-then-abort race is comfortable.
      80,
    );

    const runtimeEvents: RuntimeEvent[] = [];
    const testChannel = createTestChannel('abort-queue');

    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      onEvent: (e) => runtimeEvents.push(e),
      dependencies: { createProviderProjection: () => createTestProvider(client) },
    });

    const sk = 'main';

    try {
      // Kick off the first turn through Channel ingress. Do NOT await it.
      const firstDispatch = testChannel.dispatch({
        sessionKey: sk,
        message: 'first',
        clientId: 'abort-client',
      });

      // Wait until the turn is definitely in-flight (activeAborts registered).
      // We probe via the RuntimeApp private map by querying our own
      // querySessionsNeedingAbort via a stub channel would be cleaner, but
      // for the script a short sleep is fine.
      await new Promise((r) => setTimeout(r, 40));

      const queued = [2, 3, 4].map((index) => testChannel.dispatch({
        sessionKey: sk,
        message: `queued-${index}`,
        clientId: 'abort-client',
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now abort. Should return { aborted: true, dropped: 3 } and emit
      // the messages_dropped runtime event.
      const abortResult = app.application.abortTurn(sk);
      console.log('  abortTurn returned =', abortResult);
      assert.equal(abortResult.aborted, true, 'active turn must be aborted');
      assert.equal(abortResult.dropped, 3, 'all queued messages must be counted');

      await firstDispatch;
      await Promise.allSettled(queued);

      const dropEvt = runtimeEvents.find((e) => e.type === 'messages_dropped');
      console.log('  messages_dropped   =', dropEvt);
      assert.ok(dropEvt, 'messages_dropped event must fire');
      assert.equal((dropEvt as { sessionKey: string }).sessionKey, sk);
      assert.equal((dropEvt as { reason: string }).reason, 'abort');
      assert.equal((dropEvt as { dropped: number }).dropped, 3);
    } finally {
      await app.close('scenario 3 done').catch(() => undefined);
    }
  });
}

// ── Scenario 4: shutdown aborts in-flight ───────────────────

async function scenarioShutdownAborts(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    await writeAgentDir(workspaceDir);

    // Same long-stream setup as scenario 3.
    const { client } = createSignalAwareLLM(
      [[
        { type: 'message_start' },
        { type: 'text_delta', text: 'streaming...' },
      ]],
      80,
    );

    const app = await RuntimeApp.create({
      workspaceDir,
      deadlinePolicy: {
        shutdownGracefulDrainMs: 20,
        shutdownAbortConvergenceMs: 500,
        shutdownOverallMs: 1_000,
      },
      dependencies: { createProviderProjection: () => createTestProvider(client) },
    });

    try {
      const turnPromise = app.application.runTurn({
        sessionKey: 'main',
        message: 'go',
        promptMode: 'full',
      });

      // Let the turn get in-flight.
      await new Promise((r) => setTimeout(r, 40));

      // Shutdown. Spec §8.5 abort-then-wait: signal fires immediately,
      // then Promise.allSettled(inFlightRuns) awaits the aborted turn
      // to unwind. Should return well under a second for a signal-
      // responsive mock LLM.
      const closeStart = Date.now();
      await app.close('e2e shutdown test');
      const closeMs = Date.now() - closeStart;
      console.log('  close duration =', closeMs, 'ms');
      assert.ok(closeMs < 1000, `close should complete quickly for signal-responsive turn; got ${closeMs}ms`);

      // The in-flight turn should have resolved with stopReason='aborted'
      // (not rejected) — its inner catch converts AbortError to a
      // structured result.
      const result = await turnPromise;
      console.log('  turn stopReason =', result.stopReason);
      assert.equal(result.stopReason, 'aborted', 'shutdown-triggered abort should surface as aborted');
    } catch (err) {
      // Ensure the app is closed even on assertion failure so vitest
      // process doesn't hang on leftover disposables.
      throw err;
    }
  });
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runStep('1. abort mid-stream → stopReason/text/usage/abortMeta', scenarioAbortMidStream);
  await runStep('2. orphan tool_use repair on next turn', scenarioOrphanRepair);
  await runStep('3. messages_dropped when abort with queued messages', scenarioMessagesDropped);
  await runStep('4. shutdown aborts in-flight turn (abort-then-wait)', scenarioShutdownAborts);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('unhandled error:', err);
  process.exit(1);
});
