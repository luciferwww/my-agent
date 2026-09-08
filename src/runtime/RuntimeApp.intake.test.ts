import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  ChannelCompletion,
  ChannelRunRequest,
  InboundContentBlock,
} from '../adapters/channel/types.js';
import type { ChatContentBlock, ChatMessage } from '../adapters/llm/types.js';
import type { RunResult } from '../core/runner/types.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
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

// 单元测试用 mock：跳过真实 sharp 解码，直接受控注入 normalized + dropped
const processInboundMock = vi.fn<
  (msg: string | InboundContentBlock[]) => Promise<ProcessInboundResult>
>();

vi.mock('../core/media/attachment-pipeline.js', () => ({
  processInboundMessage: (msg: string | InboundContentBlock[]) =>
    processInboundMock(msg),
}));

describe('RuntimeApp intake (PR-6 spec matrix)', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-intake-test-'));
    processInboundMock.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('text-only message passes through untouched', async () => {
    processInboundMock.mockResolvedValue({ normalized: 'hello', dropped: [] });

    const { app, runnerRun, testChannel, agentEvents, runtimeEvents } =
      await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
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

    const { app, runnerRun, testChannel } = await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
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

  it('appends drop notice to existing text when ATTACHMENT_DROP_NOTICE_DEFAULT=true and a block dropped', async () => {
    // Default constant is true, so notice should be appended
    processInboundMock.mockResolvedValue({
      normalized: 'hello world',
      dropped: [{ blockIndex: 1, reason: 'too_large' }] satisfies DroppedAttachment[],
    });

    const { app, runnerRun, testChannel, agentEvents, runtimeEvents } =
      await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
      message: 'hello world',
      clientId: 'c1',
    });

    const got = runnerRun.mock.calls[0]?.[0]?.message;
    expect(typeof got).toBe('string');
    expect(got).toContain('hello world');
    expect(got).toContain('1 个附件');
    assertNoAttachmentEvents(runtimeEvents, agentEvents);
    await app.close();
  });

  it('pure-bad-attachments with empty text falls back to notice text (notice enabled)', async () => {
    processInboundMock.mockResolvedValue({
      normalized: [],
      dropped: [{ blockIndex: 0, reason: 'unsupported_mime' }],
    });

    const { app, runnerRun, testChannel } = await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
      message: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'x' },
        },
      ] satisfies InboundContentBlock[],
      clientId: 'c1',
    });

    expect(runnerRun).toHaveBeenCalledTimes(1);
    const got = runnerRun.mock.calls[0]?.[0]?.message;
    expect(typeof got).toBe('string');
    expect(got).toContain('1 个附件');
    await app.close();
  });

  it('degenerate input (no text, no successful attachments, no drops) skips enqueue', async () => {
    processInboundMock.mockResolvedValue({ normalized: '', dropped: [] });

    const { app, runnerRun, testChannel } = await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
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

    const { app, testChannel } = await buildApp(workspaceDir, {
      steerMode: true,
      runnerRun,
    });

    // 1) First turn: text only, starts the run loop and blocks at runnerRun
    processInboundMock.mockResolvedValueOnce({
      normalized: 'first',
      dropped: [],
    });
    const firstDispatch = testChannel.dispatch({
      sessionKey: 'main',
      message: 'first',
      clientId: 'c1',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    // 2) Steering dispatch: text + image; image must be stripped
    processInboundMock.mockResolvedValueOnce({ normalized, dropped: [] });
    await testChannel.dispatch({
      sessionKey: 'main',
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

    const { app, testChannel } = await buildApp(workspaceDir, {
      steerMode: true,
      runnerRun,
    });

    processInboundMock.mockResolvedValueOnce({
      normalized: 'first',
      dropped: [],
    });
    const firstDispatch = testChannel.dispatch({
      sessionKey: 'main',
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
      sessionKey: 'main',
      message: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
        },
      ] satisfies InboundContentBlock[],
      clientId: 'c2',
    });

    releaseRun.resolve();
    await firstDispatch;

    expect(drainedSteering).toHaveLength(0);
    await app.close();
  });

  it('no attachment-related RuntimeEvent / AgentEvent / channel_error emitted on any path', async () => {
    processInboundMock.mockResolvedValue({
      normalized: 'hello',
      dropped: [{ blockIndex: 0, reason: 'unsupported_mime' }],
    });

    const { app, testChannel, runtimeEvents, agentEvents } =
      await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
      message: 'hello',
      clientId: 'c1',
    });

    assertNoAttachmentEvents(runtimeEvents, agentEvents);
    await app.close();
  });
});

// ── user_message emit tests ─────────────────────────────────────
// channel-multi-client-user-message-spec §7 unit tests
describe('RuntimeApp handleInboundChannelMessage user_message emit', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-usermsg-test-'));
    processInboundMock.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('CH-02 threads the queued user_message ID to the runner', async () => {
    processInboundMock.mockResolvedValue({ normalized: 'hello world', dropped: [] });

    const { app, testChannel, agentEvents, runnerRun } = await buildApp(workspaceDir);

    const before = Date.now();
    await testChannel.dispatch({
      sessionKey: 'main',
      message: 'hello world',
      clientId: 'client-A',
    });
    const after = Date.now();

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message');
    expect(userMsgs).toHaveLength(1);
    const evt = userMsgs[0]! as Extract<AgentEvent, { type: 'user_message' }>;
    expect(evt.sessionKey).toBe('main');
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

    const { app, testChannel, agentEvents } = await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
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

    const { app, testChannel, agentEvents } = await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
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

    const { app, testChannel, agentEvents, runnerRun } = await buildApp(workspaceDir);

    await testChannel.dispatch({
      sessionKey: 'main',
      message: '',
      clientId: 'c1',
    });

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message');
    expect(userMsgs).toHaveLength(0);
    expect(runnerRun).not.toHaveBeenCalled();

    await app.close();
  });

  it('steering path: emits deliveryMode=steering and does not spawn a new run', async () => {
    const releaseRun = createDeferred<void>();
    const runnerRun = vi.fn(async (): Promise<RunResult> => {
      await releaseRun.promise;
      return defaultRunResult('done');
    });

    const { app, testChannel, agentEvents } = await buildApp(workspaceDir, {
      steerMode: true,
      runnerRun,
    });

    // First dispatch: starts and blocks the runner
    processInboundMock.mockResolvedValueOnce({ normalized: 'first', dropped: [] });
    const first = testChannel.dispatch({
      sessionKey: 'main',
      message: 'first',
      clientId: 'client-A',
    });
    await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

    // Second dispatch: routes to steering (active turn present)
    processInboundMock.mockResolvedValueOnce({ normalized: 'steer me', dropped: [] });
    await testChannel.dispatch({
      sessionKey: 'main',
      message: 'steer me',
      clientId: 'client-B',
    });

    const userMsgs = agentEvents.filter((e) => e.type === 'user_message') as Array<
      Extract<AgentEvent, { type: 'user_message' }>
    >;
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0]!.deliveryMode).toBe('queued');
    expect(userMsgs[0]!.originClientId).toBe('client-A');
    expect(userMsgs[1]!.deliveryMode).toBe('steering');
    expect(userMsgs[1]!.originClientId).toBe('client-B');
    expect(userMsgs[1]!.content).toBe('steer me');

    // Only one runner run — steering does not spawn a new turn
    expect(runnerRun).toHaveBeenCalledTimes(1);

    releaseRun.resolve();
    await first;
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

    const { app, testChannel, agentEvents } = await buildApp(workspaceDir, {
      steerMode: true,
      runnerRun,
    });

    processInboundMock.mockResolvedValueOnce({ normalized: 'first', dropped: [] });
    const first = testChannel.dispatch({
      sessionKey: 'main',
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
      sessionKey: 'main',
      message: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
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

    const { app, testChannel, agentEvents } = await buildApp(workspaceDir, {
      useRealRunner: true,
    });

    await testChannel.dispatch({
      sessionKey: 'main',
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
  unit: RuntimeContributionUnit;
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
    unit: {
      id: `builtin-test-channel-${id}`,
      source: 'builtin',
      register(api) {
        api.registerChannel({ id, create: () => channel });
      },
    },
    async dispatch(req) {
      if (!handler) throw new Error('handler not registered');
      await handler(req);
    },
  };
}

async function buildApp(
  workspaceDir: string,
  options: {
    steerMode?: boolean;
    runnerRun?: ReturnType<typeof vi.fn>;
    useRealRunner?: boolean;
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
    createProviderProjection: () => {
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
      return [{
        id: 'test',
        protocol: 'test',
        invocationPort,
        resolveConnection: () => ({ ok: true, connection: { endpointId: 'test' } }),
        resolveModel: (modelId, connection) => ({
          ok: true,
          descriptor: {
            identity: { providerId: 'test', modelId },
            protocol: 'test',
            connection,
            facts: {
              effectiveContextLimit: { value: 200_000, source: 'deployment-config' },
              maximumOutputTokens: { value: 8192, source: 'deployment-config' },
              toolUse: { value: true, source: 'deployment-config' },
              mediaKinds: { value: ['image'], source: 'deployment-config' },
            },
          },
        }),
      }];
    },
    ...(options.useRealRunner
      ? {}
      : {
          createSessionManager: () =>
            ({ resolveSession: vi.fn(async () => ({ entry: {}, isNew: true })) }) as never,
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
    workspaceDir,
    contributionUnits: [testChannel.unit],
    cliOverrides: {
      llm: { apiKey: 'test-key', model: 'test-model' },
      memory: { enabled: false },
      ...(options.steerMode
        ? { runner: { inTurnMessageMode: 'steer' as const } }
        : {}),
    },
    dependencies: deps,
    onEvent: (e) => runtimeEvents.push(e),
    onAgentEvent: (e) => agentEvents.push(e),
  });

  return { app, runnerRun, testChannel, runtimeEvents, agentEvents };
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
