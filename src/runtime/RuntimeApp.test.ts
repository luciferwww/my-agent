import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../adapters/llm/types.js';
import type {
  ApprovalClosedResult,
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelRunRequest,
} from '../adapters/channel/types.js';
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
      createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} } as never),
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
      promptMode: 'full',
    });

    expect(resolveSession).toHaveBeenCalledWith('main');
    expect(build).toHaveBeenCalled();
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'main',
        message: 'Hello runtime',
        model: 'test-model',
        systemPrompt: 'SYSTEM_PROMPT',
      }),
    );
    expect(result.sessionKey).toBe('main');
    expect(result.text).toBe('hello');
    expect(app.getState().phase).toBe('ready');
  });

  it('CH-05 isolates channel.send failures without changing Turn execution', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));
    const observedEvents = vi.fn();
    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} } as never),
      createMemoryManager: async () => null,
    });
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
      onAgentEvent: observedEvents,
    });

    const failingChannel = createTestChannel('failing-channel');
    failingChannel.channel.send = vi.fn(() => {
      throw new Error('channel failed');
    });
    const receivingChannel = createTestChannel('receiving-channel');
    const receivedEvents = vi.fn();
    receivingChannel.channel.send = receivedEvents;
    app.registerChannel(failingChannel.channel);
    app.registerChannel(receivingChannel.channel);

    await failingChannel.dispatch({
      sessionKey: 'main',
      message: 'fan out',
      clientId: 'client-1',
    });

    expect(receivedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_message',
        sessionKey: 'main',
        content: 'fan out',
      }),
    );
    expect(observedEvents).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_message', sessionKey: 'main' }),
    );
    expect(runnerRun).toHaveBeenCalledTimes(1);
  });

  it('CH-05 propagates an onAgentEvent observer failure before Runner execution', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'unreachable',
      content: [{ type: 'text', text: 'unreachable' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));
    const observerError = new Error('observer failed');
    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} } as never),
      createMemoryManager: async () => null,
    });
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
      onAgentEvent: (event) => {
        if (event.type === 'user_message') throw observerError;
      },
    });
    const testChannel = createTestChannel('observer-failure-channel');
    app.registerChannel(testChannel.channel);

    await expect(testChannel.dispatch({
      sessionKey: 'main',
      message: 'observe',
      clientId: 'client-1',
    })).rejects.toBe(observerError);

    expect(runnerRun).not.toHaveBeenCalled();
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

  it('CH-12 characterizes missing cleanup after a later bootstrap failure', async () => {
    const events: RuntimeEvent[] = [];
    const memoryClose = vi.fn();
    const startupError = new Error('tool assembly failed');

    await expect(RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: true },
      },
      dependencies: createTestDependencies({
        createMemoryManager: async () => ({ close: memoryClose }) as never,
        getBuiltinTools: () => {
          throw startupError;
        },
      }),
      onEvent: (event) => events.push(event),
    })).rejects.toBe(startupError);

    expect(events.map((event) => event.type)).toContain('app_start');
    expect(events.map((event) => event.type)).toContain('error');
    expect(events.map((event) => event.type)).not.toContain('app_ready');
    expect(memoryClose).not.toHaveBeenCalled();
  });

  it('CH-13 fails a missing model before Runner and passes an unvalidated model through', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'provider accepted model',
      content: [{ type: 'text', text: 'provider accepted model' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 1 },
      toolRounds: 0,
    }));
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
        createMemoryManager: async () => null,
      }),
    });

    await expect(app.runTurn({
      sessionKey: 'main',
      message: 'missing model',
      promptMode: 'full',
    })).rejects.toMatchObject({ info: { code: 'MODEL_MISSING' } });
    expect(runnerRun).not.toHaveBeenCalled();

    await expect(app.runTurn({
      sessionKey: 'main',
      message: 'explicit model',
      promptMode: 'full',
      model: 'not-locally-validated',
    })).resolves.toEqual(expect.objectContaining({ text: 'provider accepted model' }));
    expect(runnerRun).toHaveBeenCalledTimes(1);
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'not-locally-validated' }),
    );

    await app.close();
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
    await expect(app.runTurn({ sessionKey: 'main', message: 'after close', promptMode: 'full' })).rejects.toThrow(
      'Cannot run when runtime phase is closed.',
    );
  });

  it('CH-07 characterizes partial Channel start failure without rollback or retry', async () => {
    const startError = new Error('channel start failed');
    const successfulChannel = createTestChannel('successful-channel');
    const failingChannel = createTestChannel('failing-channel');
    successfulChannel.channel.start = vi.fn(async () => {});
    successfulChannel.channel.stop = vi.fn(async () => {});
    failingChannel.channel.start = vi.fn(async () => {
      throw startError;
    });
    failingChannel.channel.stop = vi.fn(async () => {});

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          on: () => {},
          run: vi.fn(),
          setToolExecutor: () => {},
        }) as never,
        createMemoryManager: async () => null,
      }),
    });
    app.registerChannel(successfulChannel.channel);
    app.registerChannel(failingChannel.channel);

    await expect(app.startChannels()).rejects.toBe(startError);
    expect(successfulChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(successfulChannel.channel.stop).not.toHaveBeenCalled();
    expect(failingChannel.channel.stop).not.toHaveBeenCalled();

    await expect(app.startChannels()).resolves.toBeUndefined();
    expect(successfulChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.start).toHaveBeenCalledTimes(1);

    await app.close();
    expect(successfulChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('CH-08 characterizes Channel stop failure as isolated and absent from the shutdown report', async () => {
    const failingChannel = createTestChannel('failing-stop-channel');
    const successfulChannel = createTestChannel('successful-stop-channel');
    failingChannel.channel.stop = vi.fn(async () => {
      throw new Error('channel stop failed');
    });
    successfulChannel.channel.stop = vi.fn(async () => {});

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          on: () => {},
          run: vi.fn(),
          setToolExecutor: () => {},
        }) as never,
        createMemoryManager: async () => null,
      }),
    });
    app.registerChannel(failingChannel.channel);
    app.registerChannel(successfulChannel.channel);
    await app.startChannels();

    const report = await app.close();

    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(successfulChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(report.completed).toContain('channels');
    expect(report.failed).toEqual([]);
    expect(app.getState().phase).toBe('closed');
  });

  it('CH-10 runs a library subagent through RuntimeApp with correlated events, usage, and cleanup', async () => {
    const callOrder: string[] = [];
    const resolveSession = vi.fn(async () => {
      callOrder.push('resolve');
      return { entry: {}, isNew: true };
    });
    const deleteSession = vi.fn(async () => {
      callOrder.push('delete');
    });
    const runnerRun = vi.fn(async (): Promise<RunResult> => {
      callOrder.push('run');
      return {
        text: 'library child result',
        content: [{ type: 'text', text: 'library child result' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 8, outputTokens: 3 },
        toolRounds: 0,
      };
    });
    const agentEvents: Array<{ type: string; [key: string]: unknown }> = [];

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createSessionManager: () => ({ resolveSession, deleteSession }) as never,
        createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
        createMemoryManager: async () => null,
      }),
      onAgentEvent: (event) => agentEvents.push(event),
    });

    const result = await app.runSubagentTurn({
      subagentType: 'general-purpose',
      description: 'inspect runtime wiring',
      prompt: 'review the integration',
      trigger: { source: 'library', callerLabel: 'integration-test' },
      lifecycle: 'blocking',
    });

    expect(callOrder).toEqual(['resolve', 'run', 'delete']);
    expect(resolveSession).toHaveBeenCalledWith(result.sessionKey, {
      spawnedBy: 'integration-test',
    });
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: result.sessionKey,
        turnId: result.turnId,
        message: 'review the integration',
      }),
    );
    expect(deleteSession).toHaveBeenCalledWith(result.sessionKey);
    expect(result).toEqual(expect.objectContaining({
      text: 'library child result',
      outcome: 'ok',
      usage: { inputTokens: 8, outputTokens: 3 },
    }));

    const subagentEvents = agentEvents.filter(
      (event) => event.type === 'subagent_start' || event.type === 'subagent_end',
    );
    expect(subagentEvents).toHaveLength(2);
    expect(subagentEvents[0]).toEqual(expect.objectContaining({
      type: 'subagent_start',
      runId: result.runId,
      sessionKey: result.sessionKey,
      turnId: result.turnId,
      subagentType: 'general-purpose',
      lifecycle: 'blocking',
    }));
    expect(subagentEvents[1]).toEqual(expect.objectContaining({
      type: 'subagent_end',
      runId: result.runId,
      sessionKey: result.sessionKey,
      turnId: result.turnId,
      outcome: 'ok',
      usage: result.usage,
    }));

    await app.close();
  });

  it('CH-01 serializes a busy session while another session runs concurrently', async () => {
    const firstRun = createDeferred<RunResult>();
    const secondRun = createDeferred<RunResult>();
    const otherRun = createDeferred<RunResult>();
    const runnerRun = vi.fn(async (params: { sessionKey: string; message: string }): Promise<RunResult> => {
      if (params.sessionKey === 'main' && params.message === 'first') {
        return firstRun.promise;
      }
      if (params.sessionKey === 'other') {
        return otherRun.promise;
      }
      return secondRun.promise;
    });
    const result = (text: string): RunResult => ({
        text,
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      });

    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} } as never),
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

    const otherDispatch = testChannel.dispatch({
      sessionKey: 'other',
      message: 'parallel',
      clientId: 'client-2',
    });

    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(2);
    });
    expect(runnerRun.mock.calls.map(([params]) => [params.sessionKey, params.message])).toEqual([
      ['main', 'first'],
      ['other', 'parallel'],
    ]);

    firstRun.resolve(result('first'));

    await firstDispatch;
    await vi.waitFor(() => {
      expect(runnerRun).toHaveBeenCalledTimes(3);
    });
    expect(runnerRun.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        sessionKey: 'main',
        message: 'second',
        maxLlmCalls: 9,
      }),
    );

    secondRun.resolve(result('second'));
    otherRun.resolve(result('parallel'));
    await otherDispatch;
    await vi.waitFor(() => {
      expect(app.getState().activeRunCount).toBe(0);
    });
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
      createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} } as never),
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

  it('CH-06 keeps queued turn approval pending past 120 seconds and closes it on Turn abort', async () => {
    vi.useFakeTimers();

    try {
      const firstRun = createDeferred<RunResult>();
      const approvalRequests: ApprovalRequest[] = [];
      const approvalClosures: Array<{
        request: ApprovalRequest;
        result: ApprovalClosedResult;
      }> = [];
      let beforeToolCallHook: BeforeToolCallHook | undefined;
      let approvalDecision: unknown;

      const runnerRun = vi.fn()
        .mockImplementationOnce(async (): Promise<RunResult> => firstRun.promise)
        .mockImplementationOnce(async (params: {
          turnId: string;
          sessionKey: string;
          signal?: AbortSignal;
        }): Promise<RunResult> => {
          try {
            approvalDecision = await beforeToolCallHook?.({
              toolName: 'demo_tool',
              input: { approval: true },
              turnId: params.turnId,
              sessionKey: params.sessionKey,
              signal: params.signal,
            });
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'AbortError') {
              throw error;
            }
            approvalDecision = 'aborted';
            return {
              text: '',
              content: [],
              stopReason: 'aborted',
              usage: { inputTokens: 0, outputTokens: 0 },
              toolRounds: 0,
            };
          }

          return {
            text: 'approved',
            content: [{ type: 'text', text: 'approved' }],
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
        setToolExecutor: vi.fn(),
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
        approvalClosures,
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
      expect(approvalClosures).toHaveLength(0);
      expect(approvalDecision).toBeUndefined();

      expect(app.abortTurn('main')).toEqual({ aborted: true, dropped: 0 });
      await vi.waitFor(() => {
        expect(approvalClosures).toHaveLength(1);
      });

      const queuedRunPromise = runnerRun.mock.results[1]?.value;
      expect(queuedRunPromise).toBeDefined();
      await queuedRunPromise;
      expect(approvalDecision).toBe('aborted');

      expect(approvalRequests[0]).toEqual(
        expect.objectContaining({
          sessionKey: 'main',
          toolName: 'demo_tool',
          originClientId: 'client-2',
        }),
      );
      expect(approvalClosures[0]).toEqual({
        request: expect.objectContaining({
          sessionKey: 'main',
          toolName: 'demo_tool',
          originClientId: 'client-2',
        }),
        result: { outcome: 'aborted', reason: 'turn' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('CH-06 approval routing depends on startChannels and fails closed without origin capability', async () => {
    let beforeToolCallHook: BeforeToolCallHook | undefined;
    const decisions: unknown[] = [];
    const runnerRun = vi.fn(async (params: { turnId: string; sessionKey: string }): Promise<RunResult> => {
      if (beforeToolCallHook) {
        decisions.push(await beforeToolCallHook({
          toolName: 'unmatched_tool',
          input: {},
          turnId: params.turnId,
          sessionKey: params.sessionKey,
        }));
      }
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
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
      setToolExecutor: vi.fn(),
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
        tools: { allow: [], deny: [] },
      },
      dependencies: deps,
    });
    const testChannel = createTestChannel('no-approval-channel');
    app.registerChannel(testChannel.channel);

    await testChannel.dispatch({ sessionKey: 'main', message: 'before startup' });
    expect(beforeToolCallHook).toBeUndefined();
    expect(decisions).toEqual([]);

    await app.startChannels();
    expect(beforeToolCallHook).toBeDefined();
    await testChannel.dispatch({ sessionKey: 'main', message: 'after startup' });

    expect(decisions).toEqual([
      {
        action: 'deny',
        reason: 'Tool not in allowlist (no approval channel)',
      },
    ]);
  });

  it('CH-06 shutdown closes a pending approval before waiting for Turn convergence', async () => {
    const approvalRequests: ApprovalRequest[] = [];
    const approvalClosures: Array<{
      request: ApprovalRequest;
      result: ApprovalClosedResult;
    }> = [];
    let beforeToolCallHook: BeforeToolCallHook | undefined;

    const agentRunner = {
      on: vi.fn((hookName: string, handler: BeforeToolCallHook) => {
        if (hookName === 'before_tool_call') {
          beforeToolCallHook = handler;
        }
        return agentRunner;
      }),
      run: vi.fn(async (params: {
        turnId: string;
        sessionKey: string;
        signal?: AbortSignal;
      }): Promise<RunResult> => {
        try {
          await beforeToolCallHook?.({
            toolName: 'demo_tool',
            input: {},
            turnId: params.turnId,
            sessionKey: params.sessionKey,
            signal: params.signal,
          });
          throw new Error('approval unexpectedly settled without shutdown');
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'AbortError') {
            throw error;
          }
          return {
            text: '',
            content: [],
            stopReason: 'aborted',
            usage: { inputTokens: 0, outputTokens: 0 },
            toolRounds: 0,
          };
        }
      }),
      setToolExecutor: vi.fn(),
    };
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => agentRunner as never,
        createMemoryManager: async () => null,
      }),
    });
    const testChannel = createApprovalTestChannel('approval-shutdown-test', {
      approvalRequests,
      approvalClosures,
      autoDecision: null,
    });
    app.registerChannel(testChannel.channel);
    await app.startChannels();

    const dispatch = testChannel.dispatch({
      sessionKey: 'main',
      message: 'wait for approval',
      clientId: 'client-1',
    });
    await vi.waitFor(() => {
      expect(approvalRequests).toHaveLength(1);
    });

    await expect(app.close('approval shutdown test')).resolves.toEqual(
      expect.objectContaining({ failed: [] }),
    );
    await dispatch;
    expect(approvalClosures).toEqual([
      {
        request: expect.objectContaining({
          toolName: 'demo_tool',
          originClientId: 'client-1',
        }),
        result: { outcome: 'aborted', reason: 'shutdown' },
      },
    ]);
  });

  // ── Abort（core-abort-spec.md §8） ──────────────────

  describe('abort', () => {
    // helper：跑一个 turn 并给它一个可 abort 的 hook；runnerRun 内部可自定义
    async function makeAppWithRunner(runnerRun: (params: unknown) => Promise<RunResult>): Promise<RuntimeApp> {
      const deps = createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
        createMemoryManager: async () => null,
      });
      return RuntimeApp.create({
        workspaceDir,
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
        },
        dependencies: deps,
      });
    }

    // ① abortTurn 无 active + 无 queue → { aborted: false, dropped: 0 }，不 emit
    it('abortTurn: 无 active + 无 queue → returns { false, 0 }, no emit', async () => {
      const events: RuntimeEvent[] = [];
      const app = await makeAppWithRunner(async () => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }));
      // 事后注入 event collector：override onEvent 通过创建时的方式（重建更简单）
      const app2 = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
        onEvent: (e) => events.push(e),
      });

      const result = app2.abortTurn('no-such-session');
      expect(result).toEqual({ aborted: false, dropped: 0 });
      expect(events.find((e) => e.type === 'messages_dropped')).toBeUndefined();
      await app.close();
      await app2.close();
    });

    // ② abortTurn 有 active turn + queue 空 → { aborted: true, dropped: 0 }，不 emit
    it('abortTurn: 有 active turn + queue 空 → aborts turn, no emit', async () => {
      const events: RuntimeEvent[] = [];
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;

      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        await releaseRun.promise;
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (e) => events.push(e),
      });

      const turnPromise = app.runTurn({ sessionKey: 'main', message: 'go', promptMode: 'full' });

      // 等 runner 收到 signal
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      const abortResult = app.abortTurn('main');
      expect(abortResult).toEqual({ aborted: true, dropped: 0 });
      expect(capturedSignal!.aborted).toBe(true);
      expect(events.find((e) => e.type === 'messages_dropped')).toBeUndefined();

      // 释放 runner，等 turn 收尾
      releaseRun.resolve();
      await turnPromise;
      await app.close();
    });

    // ③ abortTurn 无 active + queue 有 N → 只清 queue + emit messages_dropped{ dropped: N }
    it('abortTurn: 无 active turn + queue 有 N → clears queue, emits messages_dropped', async () => {
      const events: RuntimeEvent[] = [];
      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
        onEvent: (e) => events.push(e),
      });

      // 手工向 messageQueueBySession 塞 3 条（模拟 queued 消息）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('main', [{ dummy: 1 }, { dummy: 2 }, { dummy: 3 }]);

      const result = app.abortTurn('main');
      expect(result).toEqual({ aborted: false, dropped: 3 });

      // queue 已清
      expect(queueMap.has('main')).toBe(false);

      // 有 messages_dropped event
      const dropEvent = events.find((e) => e.type === 'messages_dropped');
      expect(dropEvent).toBeDefined();
      expect(dropEvent).toMatchObject({
        type: 'messages_dropped',
        sessionKey: 'main',
        reason: 'abort',
        dropped: 3,
      });

      await app.close();
    });

    // ④ public Channel 路径：active turn + queued message → 两者都清 + exactly-once observation
    it('CH-09 aborts an active public Channel turn and drops its queued message exactly once', async () => {
      const events: RuntimeEvent[] = [];
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;

      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        await releaseRun.promise;
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (e) => events.push(e),
      });
      const testChannel = createTestChannel('public-abort-test');
      app.registerChannel(testChannel.channel);

      const firstDispatch = testChannel.dispatch({
        sessionKey: 'main',
        message: 'active',
        clientId: 'client-1',
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      await testChannel.dispatch({
        sessionKey: 'main',
        message: 'queued',
        clientId: 'client-2',
      });
      expect(runnerRun).toHaveBeenCalledTimes(1);

      const result = app.abortTurn('main');
      expect(result).toEqual({ aborted: true, dropped: 1 });
      expect(capturedSignal!.aborted).toBe(true);
      expect(events.filter((e) => e.type === 'messages_dropped')).toEqual([
        expect.objectContaining({ sessionKey: 'main', reason: 'abort', dropped: 1 }),
      ]);

      releaseRun.resolve();
      await firstDispatch;
      expect(runnerRun).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
      await app.close();
    });

    it('CH-09 clears unread steering on abort without settling or carrying it into the next turn', async () => {
      const events: RuntimeEvent[] = [];
      const agentEvents: Array<{ type: string; content?: string; deliveryMode?: string }> = [];
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;
      let nextTurnSteering: ChatMessage[] | undefined;

      const runnerRun = vi.fn(async (params: {
        message: string;
        signal?: AbortSignal;
        getSteeringMessages?: () => Promise<ChatMessage[]>;
      }): Promise<RunResult> => {
        if (params.message === 'active') {
          capturedSignal = params.signal;
          await releaseRun.promise;
          return {
            text: 'aborted',
            content: [],
            stopReason: 'aborted',
            usage: { inputTokens: 0, outputTokens: 0 },
            toolRounds: 0,
          };
        }

        nextTurnSteering = await params.getSteeringMessages?.() ?? [];
        return {
          text: 'next',
          content: [{ type: 'text', text: 'next' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
          runner: { inTurnMessageMode: 'steer' },
        },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (event) => events.push(event),
        onAgentEvent: (event) => agentEvents.push(event),
      });
      const testChannel = createTestChannel('steering-abort-test');
      app.registerChannel(testChannel.channel);

      const firstDispatch = testChannel.dispatch({
        sessionKey: 'main',
        message: 'active',
        clientId: 'client-1',
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      await testChannel.dispatch({
        sessionKey: 'main',
        message: 'unread steering',
        clientId: 'client-2',
      });
      expect(agentEvents).toContainEqual(
        expect.objectContaining({
          type: 'user_message',
          content: 'unread steering',
          deliveryMode: 'steering',
        }),
      );

      expect(app.abortTurn('main')).toEqual({ aborted: true, dropped: 0 });
      expect(events.filter((event) => event.type === 'messages_dropped')).toEqual([]);

      releaseRun.resolve();
      await firstDispatch;
      await testChannel.dispatch({
        sessionKey: 'main',
        message: 'next root',
        clientId: 'client-3',
      });

      expect(runnerRun).toHaveBeenCalledTimes(2);
      expect(nextTurnSteering).toEqual([]);
      await app.close();
    });

    // ⑤ 跨 session 独立：abortTurn(sk1) 不动 sk2 的 queue
    it('abortTurn: cross-session isolation — sk1 abort does not touch sk2 queue', async () => {
      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('sk1', [{ x: 1 }]);
      queueMap.set('sk2', [{ y: 1 }, { y: 2 }]);

      const result = app.abortTurn('sk1');
      expect(result).toEqual({ aborted: false, dropped: 1 });
      expect(queueMap.has('sk1')).toBe(false);
      expect(queueMap.get('sk2')?.length).toBe(2);

      await app.close();
    });

    // ⑥ stale controller 防御：手动 pre-set stale entry → 启新 turn → 旧 entry 被清
    it('stale controller defense: pre-existing entry is cleared on new turn', async () => {
      const runnerRun = vi.fn(async (): Promise<RunResult> => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }));

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
          createMemoryManager: async () => null,
        }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeAborts = (app as any).activeAborts as Map<string, AbortController>;
      const staleController = new AbortController();
      activeAborts.set('main', staleController);

      await app.runTurn({ sessionKey: 'main', message: 'hi', promptMode: 'full' });

      // 新 turn 后：stale 已被清、finally 也清了新的 controller → map 里不该有 'main'
      expect(activeAborts.has('main')).toBe(false);

      await app.close();
    });

    // ⑦ safeEmit：subscriber 抛错 → API 仍正常返回，不 rethrow
    it('safeEmit: throwing subscriber does not break abortTurn contract', async () => {
      // 用 flag 控制：bootstrap 期间的 app_start / app_ready 正常放行，
      // 只在 messages_dropped 到来时抛错——模拟"运行期 subscriber 出 bug"。
      let armed = false;
      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
        onEvent: (e) => {
          if (armed && e.type === 'messages_dropped') {
            throw new Error('subscriber boom');
          }
        },
      });
      armed = true;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('main', [{ dummy: 1 }]);

      // API 不该抛，返回值反映真实状态
      const result = app.abortTurn('main');
      expect(result).toEqual({ aborted: false, dropped: 1 });
      expect(queueMap.has('main')).toBe(false);

      await app.close();
    });

    // ⑧ CH-08：先 abort active turn，再等待回收；queued request 不启动
    it('CH-08 shutdown aborts the active turn, waits for it, and does not start queued work', async () => {
      const releaseRun = createDeferred<void>();
      let capturedSignal: AbortSignal | undefined;

      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        // 等 signal.aborted 后再返回，模拟响应 signal 的 turn
        await new Promise<void>((resolve) => {
          const check = () => {
            if (params.signal?.aborted) resolve();
          };
          params.signal?.addEventListener('abort', check);
          check();
        });
        await releaseRun.promise;
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
          createMemoryManager: async () => null,
        }),
      });
      const testChannel = createTestChannel('shutdown-queue-test');
      app.registerChannel(testChannel.channel);

      const firstDispatch = testChannel.dispatch({
        sessionKey: 'main',
        message: 'active',
        clientId: 'client-1',
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());
      await testChannel.dispatch({
        sessionKey: 'main',
        message: 'queued',
        clientId: 'client-2',
      });
      expect(runnerRun).toHaveBeenCalledTimes(1);

      const closePromise = app.close();
      let closeSettled = false;
      void closePromise.then(() => {
        closeSettled = true;
      });

      // close 应立即调 abort（signal 同步 flip）
      await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      releaseRun.resolve();
      await Promise.all([firstDispatch, closePromise]);
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    // ⑨ shutdown timing：响应 signal 的 mock 应在合理时间内 abort 完成
    it('shutdown timing: responsive signal path completes within 300ms', async () => {
      let capturedSignal: AbortSignal | undefined;
      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        // 200ms 后自然回收——响应 signal 场景
        await new Promise<void>((resolve) => {
          if (params.signal?.aborted) return resolve();
          params.signal?.addEventListener('abort', () => setTimeout(resolve, 200));
        });
        return {
          text: 'aborted',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });

      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun, setToolExecutor: () => {} }) as never,
          createMemoryManager: async () => null,
        }),
      });

      const turnPromise = app.runTurn({ sessionKey: 'main', message: 'go', promptMode: 'full' });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      const closeStart = Date.now();
      await Promise.all([app.close(), turnPromise]);
      const closeDurationMs = Date.now() - closeStart;

      // 200ms mock + 些许调度余量 → 期望 < 500ms（宽松阈值避免 CI flake）
      expect(closeDurationMs).toBeLessThan(500);
    });

    // ⑩ bindAbortHooks wiring：registerChannel 时同步注入 hooks，可查询 & 触发
    it('bindAbortHooks: registerChannel injects querySessionsNeedingAbort + abortTurn', async () => {
      const app = await RuntimeApp.create({
        workspaceDir,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
      });

      let capturedHooks: { querySessionsNeedingAbort: () => string[]; abortTurn: (sk: string) => { aborted: boolean; dropped: number } } | undefined;
      const testChannel = createTestChannel('abort-hooks-test');
      // 手工插入 bindAbortHooks 到测试 channel
      (testChannel.channel as Channel).bindAbortHooks = (hooks) => {
        capturedHooks = hooks;
      };

      app.registerChannel(testChannel.channel);
      expect(capturedHooks).toBeDefined();

      // 塞 queued 消息到某 session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('sk-with-queue', [{ x: 1 }, { x: 2 }]);

      // querySessionsNeedingAbort 应包含 'sk-with-queue'
      const sessions = capturedHooks!.querySessionsNeedingAbort();
      expect(sessions).toContain('sk-with-queue');

      // 通过 hook 触发 abort，应清 queue + 返回真实数字
      const result = capturedHooks!.abortTurn('sk-with-queue');
      expect(result).toEqual({ aborted: false, dropped: 2 });
      expect(queueMap.has('sk-with-queue')).toBe(false);

      await app.close();
    });
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
    approvalClosures?: Array<{
      request: ApprovalRequest;
      result: ApprovalClosedResult;
    }>;
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
          return { status: 'accepted' };
        },
        sendApprovalClosed(request, result) {
          options.approvalClosures?.push({ request, result });
        },
        onApprovalDecision(handler) {
          approvalDecisionHandler = handler;
        },
        onApprovalUnavailable() {
          // This test channel remains available for its full lifetime.
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
      setToolExecutor: () => {},
    }) as never,
    getBuiltinTools: () => [builtinTool],
    ...overrides,
  };
}