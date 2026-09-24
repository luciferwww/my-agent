import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  ChannelCompletion,
  ChannelRunRequest,
  InboundContentBlock,
} from '../core/channel/index.js';
import type { ChatContentBlock, ChatMessage } from '../core/model-invocation/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import type { RunParams, RunResult } from '../core/runner/types.js';
import { SessionManager } from '../core/session/SessionManager.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import { createLoadedRuntimeUnit, type LoadedRuntimeUnit } from './runtime-unit.js';
import type { Tool } from '../core/tools/types.js';
import {
  AgentRunner,
  type AgentEvent,
  type AgentRunnerConfig,
} from '../core/runner/index.js';
import type {
  DroppedAttachment,
  ProcessInboundResult,
} from '../core/media/attachment-pipeline.js';
import { RuntimeApp } from './RuntimeApp.js';
import type { RuntimeHandle } from './runtime-composition.js';
import type { RuntimeDependencies, RuntimeEvent } from './types.js';
import { createDefaultAgentConfig } from '../platform/config/default-composition.js';
import { DEFAULT_LOGGER_CONFIG } from '../platform/logger/index.js';

// 单元测试用 mock：跳过真实 sharp 解码，直接受控注入 normalized + dropped
const processInboundMock = vi.fn<
  (msg: string | InboundContentBlock[]) => Promise<ProcessInboundResult>
>();

vi.mock('../core/media/attachment-pipeline.js', () => ({
  AttachmentValidationError: class AttachmentValidationError extends Error {
    constructor(readonly failures: readonly DroppedAttachment[]) {
      super(`Inbound message rejected because ${failures.length} attachment validation failure(s) occurred.`);
    }
  },
  processInboundMessage: (msg: string | InboundContentBlock[]) =>
    processInboundMock(msg),
}));

describe('RuntimeApp intake (PR-6 spec matrix)', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'runtime-intake-test-'));
    processInboundMock.mockReset();
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  it('text-only message passes through untouched', async () => {
    processInboundMock.mockResolvedValue({ normalized: 'hello', dropped: [] });

    const { app, runnerRun, testChannel, agentEvents, runtimeEvents } =
      await buildApp(agentHome);

    await testChannel.dispatch({
      sessionId: 'main',
      message: 'hello',
      clientId: 'c1',
    });

    expect(runnerRun).toHaveBeenCalledTimes(1);
    expect(runnerRun.mock.calls[0]?.[0]?.message).toBe('hello');
    assertNoAttachmentEvents(runtimeEvents, agentEvents);
    await app.close();
  });

  it('mixed text + image message is forwarded as ChatContentBlock[]', async () => {
    const normalized: ChatContentBlock[] = [
      { type: 'text', text: 'see image' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
        dimensions: { width: 10, height: 10 },
      },
    ];
    processInboundMock.mockResolvedValue({ normalized, dropped: [] });

    const { app, runnerRun, testChannel } = await buildApp(agentHome);

    await testChannel.dispatch({
      sessionId: 'main',
      message: [{ type: 'text', text: 'see image' }] as InboundContentBlock[],
      clientId: 'c1',
    });

    const got = runnerRun.mock.calls[0]?.[0]?.message as ChatContentBlock[];
    expect(Array.isArray(got)).toBe(true);
    // First text block becomes prepend host → original "see image" text preserved within
    expect(got[0]?.type).toBe('text');
    expect((got[0] as { text: string }).text).toContain('see image');
    // Image block preserved unchanged (position + dimensions)
    expect(got[1]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png', data: 'aaaa' },
      dimensions: { width: 10, height: 10 },
    });
    await app.close();
  });

  it('does not invoke the provider path when image capability is explicitly unsupported', async () => {
    const normalized: ChatContentBlock[] = [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
      dimensions: { width: 10, height: 10 },
    }];
    processInboundMock.mockResolvedValue({ normalized, dropped: [] });

    const { app, runnerRun, testChannel } = await buildApp(agentHome, { mediaKinds: [] });
    await expect(testChannel.dispatch({
      sessionId: 'main',
      message: [{
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'aaaa' },
      }],
      clientId: 'c1',
    })).rejects.toThrow('does not support all requested media kinds');

    expect(runnerRun).not.toHaveBeenCalled();
    await app.close();
  });

  it('attempts an image request when media capability is unknown', async () => {
    const normalized: ChatContentBlock[] = [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
      dimensions: { width: 10, height: 10 },
    }];
    processInboundMock.mockResolvedValue({ normalized, dropped: [] });

    const { app, runnerRun, testChannel } = await buildApp(agentHome, { mediaKinds: null });
    await testChannel.dispatch({
      sessionId: 'main',
      message: [{
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'aaaa' },
      }],
      clientId: 'c1',
    });

    expect(runnerRun).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects text and attachments atomically when one attachment fails', async () => {
    processInboundMock.mockResolvedValue({
      normalized: 'hello world',
      dropped: [{ blockIndex: 1, reason: 'too_large' }] satisfies DroppedAttachment[],
    });

    const { app, runnerRun, testChannel, agentEvents, runtimeEvents } =
      await buildApp(agentHome);

    await expect(testChannel.dispatch({
      sessionId: 'main',
      message: 'hello world',
      clientId: 'c1',
    })).rejects.toThrow('attachment validation failure');

    expect(runnerRun).not.toHaveBeenCalled();
    expect(agentEvents).toEqual([]);
    assertNoAttachmentEvents(runtimeEvents, agentEvents);
    await app.close();
  });

  it('rejects a pure bad attachment before enqueue', async () => {
    processInboundMock.mockResolvedValue({
      normalized: [],
      dropped: [{ blockIndex: 0, reason: 'unsupported_mime' }],
    });

    const { app, runnerRun, testChannel } = await buildApp(agentHome);

    await expect(testChannel.dispatch({
      sessionId: 'main',
      message: [
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'x' },
        },
      ] satisfies InboundContentBlock[],
      clientId: 'c1',
    })).rejects.toThrow('attachment validation failure');

    expect(runnerRun).not.toHaveBeenCalled();
    await app.close();
  });

  it('degenerate input (no text, no successful attachments, no drops) skips enqueue', async () => {
    processInboundMock.mockResolvedValue({ normalized: '', dropped: [] });

    const { app, runnerRun, testChannel } = await buildApp(agentHome);

    await testChannel.dispatch({
      sessionId: 'main',
      message: '',
      clientId: 'c1',
    });

    expect(runnerRun).not.toHaveBeenCalled();
    await app.close();
  });

  it('steering: image-bearing message in steer mode strips non-text and routes only text', async () => {
    const normalized: ChatContentBlock[] = [
      { type: 'text', text: 'steer me' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
        dimensions: { width: 10, height: 10 },
      },
    ];

    const releaseRun = createDeferred<void>();
    let drainedSteering: ChatMessage[] = [];

    const runnerRun = vi.fn(async (params: {
      getSteeringMessages?: () => Promise<ChatMessage[]>;
    }): Promise<RunResult> => {
      await releaseRun.promise;
      drainedSteering = (await params.getSteeringMessages?.()) ?? [];
      return defaultRunResult('done');
    });

    const { app, testChannel } = await buildApp(agentHome, {
      steerMode: true,
      runnerRun,
    });

    // 1) First turn: text only, starts the run loop and blocks at runnerRun
    processInboundMock.mockResolvedValueOnce({
      normalized: 'first',
      dropped: [],
    });
    const firstDispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
      clientId: 'c1',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    // 2) Steering dispatch: text + image; image must be stripped
    processInboundMock.mockResolvedValueOnce({ normalized, dropped: [] });
    await testChannel.dispatch({
      sessionId: 'main',
      message: [{ type: 'text', text: 'steer me' }] as InboundContentBlock[],
      clientId: 'c2',
    });

    releaseRun.resolve();
    await firstDispatch;

    expect(drainedSteering).toHaveLength(1);
    expect(typeof drainedSteering[0]?.content).toBe('string');
    expect(drainedSteering[0]?.content).toContain('steer me');

    await app.close();
  });

  it('steering: empty post-strip text is skipped (no inbox push)', async () => {
    const releaseRun = createDeferred<void>();
    let drainedSteering: ChatMessage[] = [];

    const runnerRun = vi.fn(async (params: {
      getSteeringMessages?: () => Promise<ChatMessage[]>;
    }): Promise<RunResult> => {
      await releaseRun.promise;
      drainedSteering = (await params.getSteeringMessages?.()) ?? [];
      return defaultRunResult('done');
    });

    const { app, testChannel } = await buildApp(agentHome, {
      steerMode: true,
      runnerRun,
    });

    processInboundMock.mockResolvedValueOnce({
      normalized: 'first',
      dropped: [],
    });
    const firstDispatch = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
      clientId: 'c1',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    // Steering dispatch with only an image block (no text in normalized)
    processInboundMock.mockResolvedValueOnce({
      normalized: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
          dimensions: { width: 10, height: 10 },
        },
      ],
      dropped: [],
    });
    await testChannel.dispatch({
      sessionId: 'main',
      message: [
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'aaaa' },
        },
      ] satisfies InboundContentBlock[],
      clientId: 'c2',
    });

    releaseRun.resolve();
    await firstDispatch;

    expect(drainedSteering).toHaveLength(0);
    await app.close();
  });

  it('does not emit user or turn events for a rejected attachment message', async () => {
    processInboundMock.mockResolvedValue({
      normalized: 'hello',
      dropped: [{ blockIndex: 0, reason: 'unsupported_mime' }],
    });

    const { app, testChannel, runtimeEvents, agentEvents } =
      await buildApp(agentHome);

    await expect(testChannel.dispatch({
      sessionId: 'main',
      message: 'hello',
      clientId: 'c1',
    })).rejects.toThrow('attachment validation failure');

    expect(agentEvents).toEqual([]);
    assertNoAttachmentEvents(runtimeEvents, agentEvents);
    await app.close();
  });
});

// ── user_message emit tests ─────────────────────────────────────
// channel-multi-client-user-message-spec §7 unit tests
describe('RuntimeApp handleInboundChannelMessage user_message emit', () => {
  let agentHome: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'runtime-usermsg-test-'));
    processInboundMock.mockReset();
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  it('CH-02 threads the queued user_message ID to the runner', async () => {
    processInboundMock.mockResolvedValue({ normalized: 'hello world', dropped: [] });

    const { app, testChannel, agentEvents, runnerRun } = await buildApp(agentHome);

    const before = Date.now();
    await testChannel.dispatch({
      sessionId: 'main',
      message: 'hello world',
      clientId: 'client-A',
    });
    const after = Date.now();

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message');
    expect(userMsgs).toHaveLength(1);
    const evt = userMsgs[0]! as Extract<AgentEvent, { type: 'user_message' }>;
    expect(evt.sessionId).toBe('main');
    expect(evt.content).toBe('hello world');
    expect(evt.originClientId).toBe('client-A');
    expect(evt.deliveryMode).toBe('queued');
    expect(evt.messageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(evt.timestamp).toBeGreaterThanOrEqual(before);
    expect(evt.timestamp).toBeLessThanOrEqual(after);
    expect(evt.attachmentSummaries).toBeUndefined();

    // originMessageId threaded to runner
    expect(runnerRun).toHaveBeenCalledTimes(1);
    const runParams = runnerRun.mock.calls[0]?.[0] as { originMessageId?: string; turnId?: string };
    expect(runParams.originMessageId).toBe(evt.messageId);
    expect(runParams.turnId).toMatch(/^[0-9a-f-]{36}$/i);

    await app.close();
  });

  it('queued path: originClientId is null when clientId absent (CLI / library entry)', async () => {
    processInboundMock.mockResolvedValue({ normalized: 'from cli', dropped: [] });

    const { app, testChannel, agentEvents } = await buildApp(agentHome);

    await testChannel.dispatch({
      sessionId: 'main',
      message: 'from cli',
    });

    const evt = agentEvents.find((e) => e.type === 'user_message') as
      | Extract<AgentEvent, { type: 'user_message' }>
      | undefined;
    expect(evt).toBeDefined();
    expect(evt!.originClientId).toBeNull();

    await app.close();
  });

  it('queued path: image attachment surfaces summary but no raw bytes', async () => {
    const normalized: ChatContentBlock[] = [
      { type: 'text', text: 'look' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'YWFhYQ==' },
        dimensions: { width: 1, height: 1 },
      },
    ];
    processInboundMock.mockResolvedValue({ normalized, dropped: [] });

    const { app, testChannel, agentEvents } = await buildApp(agentHome);

    await testChannel.dispatch({
      sessionId: 'main',
      message: [{ type: 'text', text: 'look' }] as InboundContentBlock[],
      clientId: 'c1',
    });

    const evt = agentEvents.find((e) => e.type === 'user_message') as
      | Extract<AgentEvent, { type: 'user_message' }>
      | undefined;
    expect(evt).toBeDefined();
    expect(evt!.attachmentSummaries).toHaveLength(1);
    expect(evt!.attachmentSummaries![0]).toMatchObject({
      type: 'image',
      mime: 'image/png',
    });
    // raw base64 must not leak into event payload
    expect(JSON.stringify(evt)).not.toContain('YWFhYQ==');
    // text content preserved (assembleInboundMessage prepends drop notice to first
    // text block only if any dropped; here no drops so pure "look")
    expect(evt!.content).toContain('look');

    await app.close();
  });

  it('degenerate input (assembled === undefined): does not emit user_message', async () => {
    processInboundMock.mockResolvedValue({ normalized: '', dropped: [] });

    const { app, testChannel, agentEvents, runnerRun } = await buildApp(agentHome);

    await testChannel.dispatch({
      sessionId: 'main',
      message: '',
      clientId: 'c1',
    });

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message');
    expect(userMsgs).toHaveLength(0);
    expect(runnerRun).not.toHaveBeenCalled();

    await app.close();
  });

  it('promotes unread steering to distinct FIFO Turns without duplicate intake events', async () => {
    const releaseRun = createDeferred<void>();
    const releasePromotedRun = createDeferred<void>();
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      if (params.message === 'first') {
        await releaseRun.promise;
      } else if (params.message === 'steer one') {
        await releasePromotedRun.promise;
      }
      return defaultRunResult(String(params.message));
    });

    const { app, testChannel, agentEvents, runtimeEvents } = await buildApp(agentHome, {
      steerMode: true,
      runnerRun,
    });

    // First dispatch: starts and blocks the runner
    processInboundMock.mockResolvedValueOnce({ normalized: 'first', dropped: [] });
    const first = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
      clientId: 'client-A',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    // Second dispatch: routes to steering (active turn present)
    processInboundMock.mockResolvedValueOnce({ normalized: 'steer one', dropped: [] });
    await testChannel.dispatch({
      sessionId: 'main',
      message: 'steer one',
      clientId: 'client-B',
      modelReference: { providerId: 'test', modelId: 'test-model' },
      maxLlmCalls: 7,
    });
    processInboundMock.mockResolvedValueOnce({ normalized: 'steer two', dropped: [] });
    await testChannel.dispatch({
      sessionId: 'main',
      message: 'steer two',
      clientId: 'client-C',
    });

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message') as Array<
      Extract<AgentEvent, { type: 'user_message' }>
    >;
    expect(userMsgs).toHaveLength(3);
    expect(userMsgs[0]!.deliveryMode).toBe('queued');
    expect(userMsgs[0]!.originClientId).toBe('client-A');
    expect(userMsgs[1]!.deliveryMode).toBe('steering');
    expect(userMsgs[1]!.originClientId).toBe('client-B');
    expect(userMsgs[1]!.content).toBe('steer one');
    expect(userMsgs[2]!.deliveryMode).toBe('steering');
    expect(userMsgs[2]!.originClientId).toBe('client-C');

    // Steering does not interrupt or spawn a Turn before normal completion.
    expect(runnerRun).toHaveBeenCalledTimes(1);

    releaseRun.resolve();
    await first;
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(2));

    expect(runnerRun.mock.calls[1]![0]).toEqual(expect.objectContaining({
      maxLlmCalls: 7,
      originMessageId: userMsgs[1]!.messageId,
      resolvedModel: expect.objectContaining({
        identity: { providerId: 'test', modelId: 'test-model' },
      }),
    }));
    const promotedTurnId = runnerRun.mock.calls[1]![0].turnId;
    const routeMap = (
      app.application as unknown as {
        routeContextByTurn: Map<string, { originClientId?: string; originChannel?: Channel }>;
      }
    ).routeContextByTurn;
    expect(routeMap.get(promotedTurnId)).toEqual(expect.objectContaining({
      originClientId: 'client-B',
      originChannel: expect.objectContaining({ id: 'intake-test' }),
    }));

    releasePromotedRun.resolve();
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(3));
    expect(runnerRun.mock.calls.map(([params]) => params.message)).toEqual([
      'first',
      'steer one',
      'steer two',
    ]);
    const starts = runtimeEvents.filter((event) => event.type === 'turn_start');
    expect(starts.map((event) => event.originMessageId)).toEqual([
      userMsgs[0]!.messageId,
      userMsgs[1]!.messageId,
      userMsgs[2]!.messageId,
    ]);
    expect(agentEvents.filter((event) => event.type === 'user_message')).toHaveLength(3);
    await app.close();
  });

  it.each([
    { stopReason: 'max_llm_calls', expectedCalls: 1 },
    { stopReason: 'aborted', expectedCalls: 1 },
    { stopReason: 'error', expectedCalls: 2 },
  ])(
    'applies terminal steering disposition for $stopReason',
    async ({ stopReason, expectedCalls }) => {
      const releaseRun = createDeferred<void>();
      const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
        if (params.message === 'first') {
          await releaseRun.promise;
          return {
            ...defaultRunResult('first result'),
            stopReason,
          };
        }
        return defaultRunResult('promoted result');
      });
      const { app, testChannel } = await buildApp(agentHome, {
        steerMode: true,
        runnerRun,
      });

      processInboundMock.mockResolvedValueOnce({ normalized: 'first', dropped: [] });
      const first = testChannel.dispatch({
        sessionId: 'main',
        message: 'first',
      });
      await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

      processInboundMock.mockResolvedValueOnce({ normalized: 'late', dropped: [] });
      await testChannel.dispatch({
        sessionId: 'main',
        message: 'late',
      });

      releaseRun.resolve();
      await first;
      await vi.waitFor(() => {
        expect(runnerRun).toHaveBeenCalledTimes(expectedCalls);
        expect(app.application.getState().activeRunCount).toBe(0);
      });
      if (expectedCalls === 2) {
        expect(runnerRun.mock.calls[1]![0].message).toBe('late');
      }

      await app.close();
    },
  );

  it('discards unread steering when the active Turn throws', async () => {
    const releaseRun = createDeferred<void>();
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      if (params.message === 'first') {
        await releaseRun.promise;
        throw new Error('test failure');
      }
      return defaultRunResult('unexpected');
    });
    const { app, testChannel } = await buildApp(agentHome, {
      steerMode: true,
      runnerRun,
    });

    processInboundMock.mockResolvedValueOnce({ normalized: 'first', dropped: [] });
    const first = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    processInboundMock.mockResolvedValueOnce({ normalized: 'late', dropped: [] });
    await testChannel.dispatch({
      sessionId: 'main',
      message: 'late',
    });

    releaseRun.resolve();
    await expect(first).rejects.toThrow('test failure');
    await vi.waitFor(() => expect(app.application.getState().activeRunCount).toBe(0));
    expect(runnerRun).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('steering pure-attachment (R1\'): emits user_message but does not enqueue steering input', async () => {
    const releaseRun = createDeferred<void>();
    let drainedSteering: ChatMessage[] = [];

    const runnerRun = vi.fn(async (params: {
      getSteeringMessages?: () => Promise<ChatMessage[]>;
    }): Promise<RunResult> => {
      await releaseRun.promise;
      drainedSteering = (await params.getSteeringMessages?.()) ?? [];
      return defaultRunResult('done');
    });

    const { app, testChannel, agentEvents } = await buildApp(agentHome, {
      steerMode: true,
      runnerRun,
    });

    processInboundMock.mockResolvedValueOnce({ normalized: 'first', dropped: [] });
    const first = testChannel.dispatch({
      sessionId: 'main',
      message: 'first',
      clientId: 'client-A',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    // Pure-attachment steering: no text, only an image
    processInboundMock.mockResolvedValueOnce({
      normalized: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
          dimensions: { width: 1, height: 1 },
        },
      ],
      dropped: [],
    });
    await testChannel.dispatch({
      sessionId: 'main',
      message: [
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'aaaa' },
        },
      ] satisfies InboundContentBlock[],
      clientId: 'client-B',
    });

    releaseRun.resolve();
    await first;

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message') as Array<
      Extract<AgentEvent, { type: 'user_message' }>
    >;
    expect(userMsgs).toHaveLength(2);
    const steeringEvt = userMsgs[1]!;
    expect(steeringEvt.deliveryMode).toBe('steering');
    expect(steeringEvt.content).toBe('');
    expect(steeringEvt.attachmentSummaries).toHaveLength(1);

    // Steering inbox stayed empty — runner saw nothing to inject
    expect(drainedSteering).toHaveLength(0);

    await app.close();
  });

  it('CH-02 correlates a runtime-generated message ID through real runner events', async () => {
    processInboundMock.mockResolvedValue({ normalized: 'go', dropped: [] });
    const sessionId = '00000000-0000-4000-8000-000000000001';
    await new SessionManager(agentHome).materializeSession({
      sessionId,
      createdAt: 1,
    });

    const { app, testChannel, agentEvents } = await buildApp(agentHome, {
      useRealRunner: true,
    });

    await testChannel.dispatch({
      sessionId,
      message: 'go',
      clientId: 'c1',
    });

    const correlatedEvents = agentEvents.filter((event) =>
      event.type === 'user_message' || event.type === 'run_start' || event.type === 'run_end');
    expect(correlatedEvents.map((event) => event.type)).toEqual([
      'user_message',
      'run_start',
      'run_end',
    ]);
    const userMessage = correlatedEvents[0] as Extract<AgentEvent, { type: 'user_message' }>;
    const runStart = correlatedEvents[1] as Extract<AgentEvent, { type: 'run_start' }>;
    const runEnd = correlatedEvents[2] as Extract<AgentEvent, { type: 'run_end' }>;
    expect(runStart.originMessageId).toBe(userMessage.messageId);
    expect(runEnd.turnId).toBe(runStart.turnId);

    await app.close();
  });
});

// ── helpers ────────────────────────────────────────────────────

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function defaultRunResult(text: string): RunResult {
  return {
    text,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    toolRounds: 0,
  };
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
    onMessage(next) {
      handler = next;
    },
    async start() {},
    async stop() {
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    },
  };
  return {
    channel,
    unit: createLoadedRuntimeUnit({
      registration: {
      id: `builtin-test-channel-${id}`,
      source: 'builtin',
      register(api) {
        api.registerChannel({ id, create: () => channel });
      },
      },
      required: false,
    }),
    async dispatch(req) {
      if (!handler) throw new Error('handler not registered');
      await handler(req);
    },
  };
}

async function buildApp(
  agentHome: string,
  options: {
    steerMode?: boolean;
    runnerRun?: ReturnType<typeof vi.fn>;
    useRealRunner?: boolean;
    mediaKinds?: readonly ['image'] | readonly [] | null;
  } = {},
): Promise<{
  app: RuntimeHandle;
  runnerRun: ReturnType<typeof vi.fn>;
  testChannel: ReturnType<typeof createTestChannel>;
  runtimeEvents: RuntimeEvent[];
  agentEvents: AgentEvent[];
}> {
  const runnerRun =
    options.runnerRun ??
    vi.fn(async (): Promise<RunResult> => defaultRunResult('ok'));

  const builtinTool: Tool = {
    name: 'demo_tool',
    description: 'Demo tool',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { outcome: 'success', content: 'ok' };
    },
  };

  const deps: Partial<RuntimeDependencies> = {
    createBuiltinProviderUnit: () => {
      const invocationPort = options.useRealRunner
        ? ({
          async *chatStream() {
            yield { type: 'message_start' };
            yield { type: 'text_delta', text: 'ok' };
            yield {
              type: 'message_end',
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
          async chat() { throw new Error('Not used in tests'); },
        }) as never
        : ({}) as never;
      return createTestProviderUnit({
        id: 'test',
        protocol: 'test',
        models: [{ modelId: 'test-model' }],
        invocationPort,
        resolveConnection: () => ({ ok: true, connection: { endpointId: 'test' } }),
        resolveModel: (modelId, connection) => ({
          ok: true,
          descriptor: {
            identity: { providerId: 'test', modelId },
            protocol: 'test',
            connection,
            facts: {
              effectiveContextLimit: 200_000,
              maximumOutputTokens: 8192,
              toolUse: true,
              ...(options.mediaKinds === null
                ? {}
                : { mediaKinds: options.mediaKinds ?? ['image'] }),
            },
          },
        }),
      });
    },
    ...(options.useRealRunner
      ? {}
      : {
          createSessionManager: () => ({
            initialize: vi.fn(async () => undefined),
            getSession: vi.fn((sessionId: string) => ({
              sessionId,
              createdAt: 1,
              updatedAt: 1,
            })),
          }) as never,
        }),
    createMemoryManager: async () => null,
    createSystemPromptBuilder: () => ({ build: () => 'SYSTEM_PROMPT' }) as never,
    createAgentRunner: (config: AgentRunnerConfig) => options.useRealRunner
      ? new AgentRunner(config)
      : ({
          run: runnerRun,
          on: vi.fn(),
        }) as unknown as AgentRunner,
    getBuiltinContributionUnits: () => [builtinUnit(builtinTool)],
  };

  const runtimeEvents: RuntimeEvent[] = [];
  const agentEvents: AgentEvent[] = [];
  const testChannel = createTestChannel('intake-test');

  const app = await RuntimeApp.create({
    agentHome: agentHome,
    loadedUnits: [testChannel.unit],
    applicationConfig: {
      llm: {
        defaultModel: { providerId: 'test', modelId: 'test-model' },
        builtin: {
          baseURL: 'https://example.test/v1',
          models: [{ modelId: 'test-model', protocol: 'openai-responses' }],
        },
      },
      runtime: { steeringEnabled: options.steerMode ?? false },
      runner: {},
      agents: {
        defaults: createDefaultAgentConfig(),
        list: [],
      },
      logger: structuredClone(DEFAULT_LOGGER_CONFIG),
    },
    cliOverrides: {
      memory: { enabled: false },
    },
    dependencies: deps,
    onEvent: (e) => runtimeEvents.push(e),
    onAgentEvent: (e) => agentEvents.push(e),
  });

  return { app, runnerRun, testChannel, runtimeEvents, agentEvents };
}

function createTestProviderUnit(provider: ProviderProjectionEntry): LoadedRuntimeUnit {
  return createLoadedRuntimeUnit({
    registration: {
      id: 'builtin-test-provider',
      source: 'builtin',
      register(api) { api.registerProvider(provider); },
    },
    required: true,
  });
}

function builtinUnit(tool: Tool): RuntimeContributionUnit {
  return {
    id: `builtin-test-${tool.name}`,
    source: 'builtin',
    register(api) {
      api.registerTool(tool);
    },
  };
}

function assertNoAttachmentEvents(
  runtimeEvents: RuntimeEvent[],
  agentEvents: AgentEvent[],
): void {
  // No 'error' / 'warning' event with attachment-related code
  for (const e of runtimeEvents) {
    if (e.type === 'error' || e.type === 'warning') {
      expect(e.info.message.toLowerCase()).not.toContain('attachment');
      expect(e.info.code).not.toBe('RUN_REJECTED');
    }
  }
  // No attachment events on the agent-event stream either
  for (const e of agentEvents) {
    expect(e.type).not.toBe('attachment_resized' as never);
  }
}
