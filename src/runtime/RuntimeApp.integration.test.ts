import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatParams, ChatResponse, LLMClient, StreamEvent } from '../adapters/llm/types.js';
import { WebSocketChannel } from '../adapters/channel/WebSocketChannel.js';
import type { BeforeToolCallHook } from '../core/runner/index.js';
import type { RunResult } from '../core/runner/types.js';
import { SessionManager } from '../core/session/SessionManager.js';
import { RuntimeApp } from './RuntimeApp.js';
import { WebSocket } from 'ws';

describe('RuntimeApp integration', () => {
  let workspaceDir: string;
  let app: RuntimeApp | undefined;
  let channel: WebSocketChannel | undefined;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-int-test-'));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await app?.close('test shutdown').catch(() => undefined);
    await channel?.stop().catch(() => undefined);
    app = undefined;
    channel = undefined;
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('boots with real workspace/session/tool wiring and runs a turn with a mocked llm client', async () => {
    let capturedParams: ChatParams | undefined;
    let sessionManager: SessionManager | undefined;

    const llmClient: LLMClient = {
      async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
        capturedParams = params;
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'Integration hello' };
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 8 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('Not used in this test');
      },
    };

    app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createLLMClient: () => llmClient,
        createSessionManager: (dir) => {
          sessionManager = new SessionManager(dir);
          return sessionManager;
        },
      },
    });

    const result = await app.runTurn({
      sessionKey: 'main',
      message: 'Hello integration runtime',
    });

    expect(result.text).toBe('Integration hello');
    expect(capturedParams?.model).toBe('test-model');
    expect(capturedParams?.system).toContain('# Identity');
    expect(capturedParams?.tools?.length).toBeGreaterThan(0);
    expect(sessionManager?.getMessages('main')).toHaveLength(2);
  });

  it('loads config defaults and injects memory tools when memory is enabled', async () => {
    let capturedParams: ChatParams | undefined;

    const llmClient: LLMClient = {
      async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
        capturedParams = params;
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'Memory integration' };
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 16, outputTokens: 9 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('Not used in this test');
      },
    };

    await mkdir(join(workspaceDir, '.agent'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.agent', 'config.json'),
      JSON.stringify({
        agents: {
          defaults: {
            llm: {
              apiKey: 'config-key',
              model: 'config-model',
            },
            memory: {
              enabled: true,
            },
          },
        },
      }),
      'utf-8',
    );

    app = await RuntimeApp.create({
      workspaceDir,
      dependencies: {
        createLLMClient: () => llmClient,
        createMemoryManager: async () => ({
          search: async () => [],
          readFile: async () => '',
          writeFile: async () => {},
          reindex: async () => {},
          close: () => {},
        }) as never,
      },
    });

    const result = await app.runTurn({
      sessionKey: 'memory-main',
      message: 'Hello memory runtime',
    });

    expect(result.text).toBe('Memory integration');
    expect(app.getToolNames()).toContain('memory_search');
    expect(capturedParams?.model).toBe('config-model');
    expect(capturedParams?.tools?.some((tool) => tool.name === 'memory_search')).toBe(true);
    expect(capturedParams?.system).toContain('# Memory Recall');
  });

  it('reloads context files from disk when a turn requests reloadContextFiles', async () => {
    const capturedSystems: string[] = [];

    const llmClient: LLMClient = {
      async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
        capturedSystems.push(params.system ?? '');
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'Reload integration' };
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 7 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('Not used in this test');
      },
    };

    app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'reload-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createLLMClient: () => llmClient,
      },
    });

    await app.runTurn({
      sessionKey: 'reload-main',
      message: 'First turn',
    });

    await writeFile(
      join(workspaceDir, '.agent', 'IDENTITY.md'),
      '# Identity\nReloaded context marker',
      'utf-8',
    );

    const previousVersion = app.getState().contextVersion;
    await app.runTurn({
      sessionKey: 'reload-main',
      message: 'Second turn',
      reloadContextFiles: true,
    });

    expect(app.getState().contextVersion).toBe(previousVersion + 1);
    expect(capturedSystems.at(-1)).toContain('Reloaded context marker');
  });

  it('routes queued websocket approvals to the queued turn origin client end-to-end', async () => {
    const firstRun = createDeferred<RunResult>();
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

        expect(decision).toEqual({ action: 'allow' });

        return {
          text: 'second',
          content: [{ type: 'text', text: 'second' }],
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
    await expectMessage(client1, { type: 'hello_ack', clientId: 'client-1' });

    const client2 = await connectClient(channel, clients);
    client2.send(JSON.stringify({ type: 'hello', clientId: 'client-2' }));
    await expectMessage(client2, { type: 'hello_ack', clientId: 'client-2' });

    client1.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'first' }));

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    client2.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'second' }));

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    firstRun.resolve({
      text: 'first',
      content: [{ type: 'text', text: 'first' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    });

    const approvalRequested = await readMessage(client2);
    expect(approvalRequested).toEqual(expect.objectContaining({
      type: 'approval_requested',
      id: expect.any(String),
      toolName: 'demo_tool',
      input: { approval: true },
    }));

    await expectNoMessage(client1, 100);

    client2.send(JSON.stringify({
      type: 'approval_resolve',
      id: approvalRequested.id,
      decision: 'allow',
    }));

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(2);
    });
  });

  it('routes queued websocket approval expiry to the queued turn origin client end-to-end', async () => {
    const firstRun = createDeferred<RunResult>();
    const secondRunFinished = createDeferred<void>();
    let beforeToolCallHook: BeforeToolCallHook | undefined;

    const runnerRun = vi.fn()
      .mockImplementationOnce(async (): Promise<RunResult> => firstRun.promise)
      .mockImplementationOnce(async (params: { turnId: string; sessionKey: string }): Promise<RunResult> => {
        try {
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
        } finally {
          secondRunFinished.resolve();
        }
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

    const turnInteractionManager = (app as unknown as {
      turnInteractionManager: {
        request(params: Record<string, unknown>): Promise<unknown>;
      };
    }).turnInteractionManager;
    const requestInteraction = turnInteractionManager.request.bind(turnInteractionManager);
    turnInteractionManager.request = (params) => requestInteraction({
      ...params,
      timeoutMs: 100,
    });

    channel = new WebSocketChannel({ port: 0, approval: true });
    app.registerChannel(channel);
    await app.startChannels();

    const client1 = await connectClient(channel, clients);
    client1.send(JSON.stringify({ type: 'hello', clientId: 'client-1' }));
    await expectMessage(client1, { type: 'hello_ack', clientId: 'client-1' });

    const client2 = await connectClient(channel, clients);
    client2.send(JSON.stringify({ type: 'hello', clientId: 'client-2' }));
    await expectMessage(client2, { type: 'hello_ack', clientId: 'client-2' });

    client1.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'first' }));

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    client2.send(JSON.stringify({ type: 'run_turn', sessionKey: 'main', message: 'second' }));

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    firstRun.resolve({
      text: 'first',
      content: [{ type: 'text', text: 'first' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    });

    const approvalRequested = await readMessage(client2);
    expect(approvalRequested).toEqual(expect.objectContaining({
      type: 'approval_requested',
      id: expect.any(String),
      toolName: 'demo_tool',
      input: { approval: true },
    }));

    await expectNoMessage(client1, 20);

    await expectMessage(client2, {
      type: 'approval_expired',
      id: approvalRequested.id,
    });

    await expectNoMessage(client1, 20);
    await secondRunFinished.promise;
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

async function connectClient(channel: WebSocketChannel, clients: WebSocket[]): Promise<WebSocket> {
  const address = (channel as unknown as { server?: { address(): unknown } }).server?.address();
  if (!address || typeof address !== 'object' || !("port" in address)) {
    throw new Error('WebSocketChannel server address is not available');
  }

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  clients.push(client);
  await once(client, 'open');
  return client;
}

async function readMessage(client: WebSocket): Promise<Record<string, unknown>> {
  const [raw] = await once(client, 'message');
  return JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
}

async function expectMessage(client: WebSocket, expected: Record<string, unknown>): Promise<void> {
  expect(await readMessage(client)).toEqual(expected);
}

async function expectNoMessage(client: WebSocket, timeoutMs: number): Promise<void> {
  const message = await Promise.race([
    once(client, 'message').then(([raw]) => JSON.parse(raw.toString('utf-8')) as Record<string, unknown>),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);

  expect(message).toBeNull();
}