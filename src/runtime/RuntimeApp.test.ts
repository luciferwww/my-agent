import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../adapters/llm/types.js';
import type { ApprovalDecision, ApprovalRequest, Channel, ChannelRunRequest } from '../adapters/channel/types.js';
import type { BeforeToolCallHook } from '../core/runner/index.js';
import type { RunResult } from '../core/runner/types.js';
import type { Tool } from '../core/tools/types.js';
import { RuntimeApp } from './RuntimeApp.js';
import type { RuntimeDependencies, RuntimeEvent } from './types.js';

describe('RuntimeApp', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-app-test-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('creates, resolves a session automatically, and delegates a turn to AgentRunner', async () => {
    const resolveSession = vi.fn(async () => ({ entry: { sessionId: '1' }, isNew: true }));
    const build = vi.fn(() => 'SYSTEM_PROMPT');
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'hello',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
      toolRounds: 0,
    }));

    const deps = createTestDependencies({
      createSessionManager: () => ({ resolveSession } as never),
      createSystemPromptBuilder: () => ({ build } as never),
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    const result = await app.runTurn({
      sessionKey: 'main',
      message: 'Hello runtime',
    });

    expect(resolveSession).toHaveBeenCalledWith('main');
    expect(build).toHaveBeenCalled();
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'main',
        message: 'Hello runtime',
        model: 'test-model',
        systemPrompt: 'SYSTEM_PROMPT',
        inTurnMessageMode: 'followup',
      }),
    );
    expect(result.sessionKey).toBe('main');
    expect(result.text).toBe('hello');
    expect(app.getState().phase).toBe('ready');
  });

  it('degrades to warning when memory initialization fails', async () => {
    const events: RuntimeEvent[] = [];
    const deps = createTestDependencies({
      createMemoryManager: async () => {
        throw new Error('memory init failed');
      },
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
      },
      dependencies: deps,
      onEvent: (event) => events.push(event),
    });

    expect(app.getToolNames()).not.toContain('memory_search');
    expect(events.some((event) => event.type === 'warning')).toBe(true);
    expect(events.some((event) => event.type === 'app_ready')).toBe(true);
  });

  it('reloads context files, closes idempotently, and rejects future runs after close', async () => {
    await writeFile(join(workspaceDir, '.agent', 'IDENTITY.md'), '# Identity', 'utf-8').catch(() => undefined);

    const memoryClose = vi.fn();
    const deps = createTestDependencies({
      createMemoryManager: async () => ({ close: memoryClose } as never),
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: true },
      },
      dependencies: deps,
    });

    const previousVersion = app.getState().contextVersion;
    await app.reloadContextFiles();
    expect(app.getState().contextVersion).toBe(previousVersion + 1);

    await app.close('test shutdown');
    await app.close('test shutdown');

    expect(memoryClose).toHaveBeenCalledTimes(1);
    await expect(app.runTurn({ sessionKey: 'main', message: 'after close' })).rejects.toThrow(
      'Cannot run when runtime phase is closed.',
    );
  });

  it('allows per-turn inTurnMessageMode override', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'ok',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));

    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    await app.runTurn({
      sessionKey: 'main',
      message: 'Hello runtime',
      inTurnMessageMode: 'steer',
    });

    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        inTurnMessageMode: 'steer',
      }),
    );
  });

  it('queues busy-session channel messages and runs them serially', async () => {
    const firstRun = createDeferred<RunResult>();
    const runnerRun = vi.fn()
      .mockImplementationOnce(async (): Promise<RunResult> => firstRun.promise)
      .mockImplementationOnce(async (): Promise<RunResult> => ({
        text: 'second',
        content: [{ type: 'text', text: 'second' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }));

    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    const testChannel = createTestChannel('queue-test');
    app.registerChannel(testChannel.channel);

    const firstDispatch = testChannel.dispatch({
      sessionKey: 'main',
      message: 'first',
      clientId: 'client-1',
    });

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    const secondDispatch = testChannel.dispatch({
      sessionKey: 'main',
      message: 'second',
      clientId: 'client-1',
      maxLlmCalls: 9,
    });

    await secondDispatch;
    expect(runnerRun).toHaveBeenCalledTimes(1);

    firstRun.resolve({
      text: 'first',
      content: [{ type: 'text', text: 'first' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    });

    await firstDispatch;
    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(2);
    });
    expect(runnerRun.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        sessionKey: 'main',
        message: 'second',
        maxLlmCalls: 9,
      }),
    );
  });

  it('routes busy-session channel input to steering when steer mode is enabled', async () => {
    const releaseRun = createDeferred<void>();
    let drainedSteering: ChatMessage[] = [];
    const runnerRun = vi.fn(async (params: {
      getSteeringMessages?: () => Promise<ChatMessage[]>;
    }): Promise<RunResult> => {
      await releaseRun.promise;
      drainedSteering = await params.getSteeringMessages?.() ?? [];
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });

    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
        runner: { inTurnMessageMode: 'steer' },
      },
      dependencies: deps,
    });

    const testChannel = createTestChannel('steer-test');
    app.registerChannel(testChannel.channel);

    const firstDispatch = testChannel.dispatch({
      sessionKey: 'main',
      message: 'first',
      clientId: 'client-1',
    });

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    const steeringDispatch = testChannel.dispatch({
      sessionKey: 'main',
      message: 'steer now',
      clientId: 'client-2',
    });

    await steeringDispatch;
    expect(runnerRun).toHaveBeenCalledTimes(1);

    releaseRun.resolve();
    await firstDispatch;

    expect(drainedSteering).toEqual([
      {
        role: 'user',
        content: 'steer now',
      },
    ]);
  });

  it('routes queued turn approval expiry to the queued turn origin client', async () => {
    vi.useFakeTimers();

    try {
      const firstRun = createDeferred<RunResult>();
      const approvalRequests: ApprovalRequest[] = [];
      const approvalExpiries: ApprovalRequest[] = [];
      let beforeToolCallHook: BeforeToolCallHook | undefined;

      const runnerRun = vi.fn()
        .mockImplementationOnce(async (): Promise<RunResult> => firstRun.promise)
        .mockImplementationOnce(async (params: { turnId: string; sessionKey: string }): Promise<RunResult> => {
          const decision = await beforeToolCallHook?.({
            toolName: 'demo_tool',
            input: { approval: true },
            turnId: params.turnId,
            sessionKey: params.sessionKey,
          });

          expect(decision).toEqual({ action: 'deny', reason: 'Denied by timeout' });

          return {
            text: 'timed out',
            content: [{ type: 'text', text: 'timed out' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
            toolRounds: 0,
          };
        });

      const agentRunner = {
        on: vi.fn((hookName: string, handler: BeforeToolCallHook) => {
          if (hookName === 'before_tool_call') {
            beforeToolCallHook = handler;
          }
          return agentRunner;
        }),
        run: runnerRun,
      };

      const deps = createTestDependencies({
        createAgentRunner: () => agentRunner as never,
        createMemoryManager: async () => null,
      });

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
        },
        dependencies: deps,
      });

      const testChannel = createApprovalTestChannel('approval-expiry-queue-test', {
        approvalRequests,
        approvalExpiries,
        autoDecision: null,
      });
      app.registerChannel(testChannel.channel);
      await app.startChannels();

      const firstDispatch = testChannel.dispatch({
        sessionKey: 'main',
        message: 'first',
        clientId: 'client-1',
      });

      await vi.waitFor(() => {
        expect(runnerRun).toHaveBeenCalledTimes(1);
      });

      const secondDispatch = testChannel.dispatch({
        sessionKey: 'main',
        message: 'second',
        clientId: 'client-2',
      });

      await secondDispatch;
      expect(runnerRun).toHaveBeenCalledTimes(1);

      firstRun.resolve({
        text: 'first',
        content: [{ type: 'text', text: 'first' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

      await firstDispatch;
      await vi.waitFor(() => {
        expect(approvalRequests).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => {
        expect(approvalExpiries).toHaveLength(1);
      });

      expect(approvalRequests[0]).toEqual(
        expect.objectContaining({
          sessionKey: 'main',
          toolName: 'demo_tool',
          originClientId: 'client-2',
        }),
      );
      expect(approvalExpiries[0]).toEqual(
        expect.objectContaining({
          sessionKey: 'main',
          toolName: 'demo_tool',
          originClientId: 'client-2',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestChannel(id: string): {
  channel: Channel;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;

  return {
    channel: {
      id,
      send() {
        // no-op for tests
      },
      onMessage(nextHandler) {
        handler = nextHandler;
      },
      async start() {
        // no-op for tests
      },
      async stop() {
        // no-op for tests
      },
    },
    async dispatch(req: ChannelRunRequest) {
      if (!handler) {
        throw new Error('message handler was not registered');
      }
      await handler(req);
    },
  };
}

function createApprovalTestChannel(
  id: string,
  options: {
    approvalRequests: ApprovalRequest[];
    approvalExpiries?: ApprovalRequest[];
    autoDecision?: ApprovalDecision | null;
  },
): {
  channel: Channel;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  let approvalDecisionHandler: ((id: string, decision: ApprovalDecision) => void) | undefined;
  const autoDecision = options.autoDecision === undefined ? 'allow' : options.autoDecision;

  return {
    channel: {
      id,
      send() {
        // no-op for tests
      },
      onMessage(nextHandler) {
        handler = nextHandler;
      },
      async start() {
        // no-op for tests
      },
      async stop() {
        // no-op for tests
      },
      approval: {
        sendApprovalRequest(request) {
          options.approvalRequests.push(request);
          if (autoDecision) {
            approvalDecisionHandler?.(request.id, autoDecision);
          }
        },
        sendApprovalExpired(request) {
          options.approvalExpiries?.push(request);
        },
        onApprovalDecision(handler) {
          approvalDecisionHandler = handler;
        },
      },
    },
    async dispatch(req: ChannelRunRequest) {
      if (!handler) {
        throw new Error('message handler was not registered');
      }
      await handler(req);
    },
  };
}

function createTestDependencies(
  overrides: Partial<RuntimeDependencies> = {},
): Partial<RuntimeDependencies> {
  const builtinTool: Tool = {
    name: 'demo_tool',
    description: 'Demo tool',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { content: 'ok' };
    },
  };

  return {
    createLLMClient: () => ({}) as never,
    createSessionManager: () => ({ resolveSession: vi.fn(async () => ({ entry: {}, isNew: true })) }) as never,
    createMemoryManager: async () => null,
    createSystemPromptBuilder: () => ({ build: () => 'SYSTEM_PROMPT' }) as never,
    createAgentRunner: () => ({
      run: async () => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }),
    }) as never,
    getBuiltinTools: () => [builtinTool],
    ...overrides,
  };
}