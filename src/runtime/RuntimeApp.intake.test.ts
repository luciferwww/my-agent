import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  ChannelRunRequest,
  InboundContentBlock,
} from '../adapters/channel/types.js';
import type { ChatContentBlock, ChatMessage } from '../adapters/llm/types.js';
import type { RunResult } from '../core/runner/types.js';
import type { Tool } from '../core/tools/types.js';
import type {
  AgentEvent,
  AgentRunner,
  AgentRunnerConfig,
} from '../core/runner/index.js';
import type {
  DroppedAttachment,
  ProcessInboundResult,
} from '../core/media/attachment-pipeline.js';
import { RuntimeApp } from './RuntimeApp.js';
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
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  return {
    channel: {
      id,
      send() {},
      onMessage(next) {
        handler = next;
      },
      async start() {},
      async stop() {},
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
  } = {},
): Promise<{
  app: RuntimeApp;
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
      return { content: 'ok' };
    },
  };

  const deps: Partial<RuntimeDependencies> = {
    createLLMClient: () => ({}) as never,
    createSessionManager: () =>
      ({ resolveSession: vi.fn(async () => ({ entry: {}, isNew: true })) }) as never,
    createMemoryManager: async () => null,
    createSystemPromptBuilder: () => ({ build: () => 'SYSTEM_PROMPT' }) as never,
    createAgentRunner: (_config: AgentRunnerConfig) =>
      ({
        run: runnerRun,
        on: vi.fn(),
      }) as unknown as AgentRunner,
    getBuiltinTools: () => [builtinTool],
  };

  const runtimeEvents: RuntimeEvent[] = [];
  const agentEvents: AgentEvent[] = [];

  const app = await RuntimeApp.create({
    workspaceDir,
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

  const testChannel = createTestChannel('intake-test');
  app.registerChannel(testChannel.channel);

  return { app, runnerRun, testChannel, runtimeEvents, agentEvents };
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
