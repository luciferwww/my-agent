import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../core/model-invocation/index.js';
import type {
  ApprovalClosedResult,
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelCompletion,
  ChannelRunRequest,
} from '../adapters/channel/types.js';
import type { AgentEvent, BeforeToolCallHook } from '../core/runner/index.js';
import type { RunParams, RunResult } from '../core/runner/types.js';
import type { Tool } from '../core/tools/types.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import { createLoadedRuntimeUnit, type LoadedRuntimeUnit } from './runtime-unit.js';
import type { ResolvedModel } from '../core/model-resolution/index.js';
import type { SubagentModelSelection } from '../platform/config/types.js';
import { RuntimeApp } from './RuntimeApp.js';
import type { RuntimeHandle } from './runtime-composition.js';
import type { RuntimeDependencies, RuntimeEvent } from './types.js';
import type { RuntimeDeadlineDriver, RuntimeDeadlineRaceResult } from './runtime-deadline.js';

class ManualDeadlineDriver implements RuntimeDeadlineDriver {
  private nowMs = 0;
  private readonly deadlines = new Set<{
    deadline: number;
    resolve: (result: RuntimeDeadlineRaceResult<unknown>) => void;
  }>();

  now(): number {
    return this.nowMs;
  }

  get pendingCount(): number {
    return this.deadlines.size;
  }

  race<T>(operation: Promise<T>, absoluteDeadline: number): Promise<RuntimeDeadlineRaceResult<T>> {
    return new Promise((resolve) => {
      let settled = false;
      const waiter = {
        deadline: absoluteDeadline,
        resolve: (result: RuntimeDeadlineRaceResult<unknown>) => {
          if (settled) return;
          settled = true;
          this.deadlines.delete(waiter);
          resolve(result as RuntimeDeadlineRaceResult<T>);
        },
      };
      this.deadlines.add(waiter);
      void operation.then(
        (value) => waiter.resolve({ outcome: 'completed', value }),
        (error: unknown) => waiter.resolve({
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      if (absoluteDeadline <= this.nowMs) waiter.resolve({ outcome: 'deadline-exhausted' });
    });
  }

  advanceBy(milliseconds: number): void {
    this.nowMs += milliseconds;
    for (const waiter of [...this.deadlines]) {
      if (waiter.deadline <= this.nowMs) waiter.resolve({ outcome: 'deadline-exhausted' });
    }
  }
}

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

    const result = await app.application.runTurn({
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
        resolvedModel: expect.objectContaining({
          identity: { providerId: 'test', modelId: 'test-model' },
          referenceSource: 'config-default',
        }),
        systemPrompt: 'SYSTEM_PROMPT',
      }),
    );
    expect(result.sessionKey).toBe('main');
    expect(result.text).toBe('hello');
    expect(app.application.getState().phase).toBe('ready');
  });

  it.each([
    {
      label: 'inherited',
      selection: 'inherit' as const,
      expectedIdentity: { providerId: 'test', modelId: 'parent-model' },
    },
    {
      label: 'concrete',
      selection: { providerId: 'child', modelId: 'child-model' },
      expectedIdentity: { providerId: 'child', modelId: 'child-model' },
    },
  ])('delegates a real Parent task through fresh $label Child resolution', async ({
    selection,
    expectedIdentity,
  }: {
    selection: SubagentModelSelection;
    expectedIdentity: { providerId: string; modelId: string };
  }) => {
    let parentModel: ResolvedModel | undefined;
    let childModel: ResolvedModel | undefined;
    const deleteSession = vi.fn(async () => {});
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      if (params.sessionKey === 'main') {
        parentModel = params.resolvedModel;
        const taskTool = params.toolProjection.resolve('task');
        if (!taskTool || !params.signal) throw new Error('Parent task wiring is incomplete.');
        const taskResult = await taskTool.execute({
          subagent_type: 'reviewer',
          description: 'review',
          prompt: 'inspect the patch',
        }, {
          sessionKey: params.sessionKey,
          turnId: params.turnId,
          callId: 'task-use-1',
          signal: params.signal,
        });
        return {
          text: taskResult.content,
          content: [{ type: 'text', text: taskResult.content }],
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 2 },
          toolRounds: 1,
        };
      }
      childModel = params.resolvedModel;
      return {
        text: 'child result',
        content: [{ type: 'text', text: 'child result' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const makeProvider = (id: string) => ({
      id,
      protocol: 'test',
      invocationPort: {} as never,
      resolveConnection: () => ({ ok: true as const, connection: { endpointId: `${id}-endpoint` } }),
      resolveModel: (modelId: string, connection: { endpointId: string }) => ({
        ok: true as const,
        descriptor: {
          identity: { providerId: id, modelId },
          protocol: 'test',
          connection,
          facts: {
            effectiveContextLimit: { value: 200_000, source: 'deployment-config' as const },
            maximumOutputTokens: { value: 8192, source: 'deployment-config' as const },
            toolUse: { value: true, source: 'deployment-config' as const },
          },
        },
      }),
    });
    const events: AgentEvent[] = [];
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'parent-model' },
        memory: { enabled: false },
        subagents: {
          enabled: true,
          maxDepth: 1,
          list: [{
            id: 'reviewer',
            description: 'reviews code',
            model: selection,
          }],
        },
      },
      dependencies: createTestDependencies({
        createProviderProjection: () => [makeProvider('test'), makeProvider('child')],
        createSessionManager: () => ({
          resolveSession: vi.fn(async () => ({ entry: {}, isNew: true })),
          deleteSession,
        }) as never,
        createAgentRunner: () => ({
          run: runnerRun,
        }) as never,
        createMemoryManager: async () => null,
      }),
      onAgentEvent: (event) => events.push(event),
    });

    const result = await app.application.runTurn({
      sessionKey: 'main',
      message: 'delegate',
      promptMode: 'full',
    });

    expect(result.text).toBe('child result');
    expect(parentModel?.identity).toEqual({ providerId: 'test', modelId: 'parent-model' });
    expect(childModel?.identity).toEqual(expectedIdentity);
    expect(childModel).not.toBe(parentModel);
    expect(events.filter((event) => event.type === 'subagent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
    expect(deleteSession).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('pins Parent and Child resolution to N while a new Root uses N+1', async () => {
    const parentEntered = createDeferred<void>();
    const continueParent = createDeferred<void>();
    let childRuns = 0;
    let taskOutcome: string | undefined;
    let newRootProviderId: string | undefined;
    let childProviderId: string | undefined;
    let childHasGenerationOneTool = false;
    let childHasGenerationOneHook = false;
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      if (params.sessionKey === 'parent') {
        parentEntered.resolve();
        await continueParent.promise;
        const task = params.toolProjection.resolve('task');
        if (!task || !params.signal) throw new Error('Parent task wiring is incomplete.');
        const result = await task.execute({
          subagent_type: 'next-generation',
          description: 'generation check',
          prompt: 'must stay pinned',
        }, {
          sessionKey: params.sessionKey,
          turnId: params.turnId,
          callId: 'generation-task',
          signal: params.signal,
        });
        taskOutcome = result.outcome;
      } else if (params.sessionKey === 'new-root') {
        newRootProviderId = params.resolvedModel.identity.providerId;
      } else {
        childRuns += 1;
        childProviderId = params.resolvedModel.identity.providerId;
        childHasGenerationOneTool = params.toolProjection.resolve('generation-one-tool') !== undefined;
        childHasGenerationOneHook = params.hookProjection.beforeToolCall.some(
          (hook) => hook.contributionId === 'generation-one-hook',
        );
      }
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const nextProvider = {
      id: 'next-provider',
      protocol: 'test',
      invocationPort: {} as never,
      resolveConnection: () => ({ ok: true as const, connection: { endpointId: 'next' } }),
      resolveModel: (modelId: string, connection: { endpointId: string }) => ({
        ok: true as const,
        descriptor: {
          identity: { providerId: 'next-provider', modelId },
          protocol: 'test',
          connection,
          facts: {
            effectiveContextLimit: { value: 200_000, source: 'deployment-config' as const },
            maximumOutputTokens: { value: 8192, source: 'deployment-config' as const },
            toolUse: { value: true, source: 'deployment-config' as const },
          },
        },
      }),
    };
    const nextProviderUnit = createLoadedRuntimeUnit({
      registration: {
        id: 'next-provider-unit',
        source: 'external',
        register(api) { api.registerProvider(nextProvider); },
      },
      required: false,
      initiallyEnabled: false,
    });
    const generationOneUnit = createLoadedRuntimeUnit({
      registration: {
        id: 'generation-one-unit',
        source: 'external',
        register(api) {
          api.registerTool({
            name: 'generation-one-tool',
            description: 'marks generation one',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => ({ outcome: 'success', content: 'generation one' }),
          });
          api.registerHook({
            id: 'generation-one-hook',
            hookName: 'before_tool_call',
            handler: () => ({ action: 'allow' as const }),
          });
        },
      },
      required: false,
      initiallyEnabled: true,
    });
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [generationOneUnit, nextProviderUnit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'parent-model' },
        memory: { enabled: false },
        subagents: {
          enabled: true,
          maxDepth: 1,
          list: [{
            id: 'next-generation',
            description: 'inherits the Parent Provider',
            model: 'inherit',
          }],
        },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createSessionManager: () => ({
          resolveSession: vi.fn(async () => ({ entry: {}, isNew: true })),
          deleteSession: vi.fn(async () => {}),
        }) as never,
        createMemoryManager: async () => null,
      }),
    });

    const parent = app.application.runTurn({
      sessionKey: 'parent',
      message: 'hold generation one',
      promptMode: 'full',
    });
    await parentEntered.promise;
    await expect(app.composition.enableUnit('next-provider-unit')).resolves.toEqual(
      expect.objectContaining({ outcome: 'published', generation: 2 }),
    );
    continueParent.resolve();
    await parent;

    expect(taskOutcome).toBe('success');
    expect(childRuns).toBe(1);
    expect(childProviderId).toBe('test');
    expect(childHasGenerationOneTool).toBe(true);
    expect(childHasGenerationOneHook).toBe(true);
    await app.application.runTurn({
      sessionKey: 'new-root',
      message: 'use generation two',
      modelReference: { providerId: 'next-provider', modelId: 'root-model' },
      promptMode: 'full',
    });
    expect(newRootProviderId).toBe('next-provider');

    await app.close();
  });

  it('seals a direct model-resolution failure with one failed turn_end', async () => {
    const events: RuntimeEvent[] = [];
    const app = await RuntimeApp.create({
      workspaceDir,
      onEvent: (event) => events.push(event),
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({ createMemoryManager: async () => null }),
    });

    await expect(app.application.runTurn({
      requestId: 'request-resolution-failure',
      sessionKey: 'main',
      message: 'fail resolution',
      modelReference: { providerId: 'missing-provider', modelId: 'missing-model' },
      promptMode: 'full',
    })).rejects.toThrow();

    const terminal = events.filter((event) =>
      event.type === 'turn_end' && event.requestId === 'request-resolution-failure');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ outcome: 'failed', turnId: expect.any(String) });
    await app.close();
  });

  it('seals a direct Runner failure with one caller rejection and one failed turn_end', async () => {
    const events: RuntimeEvent[] = [];
    const app = await RuntimeApp.create({
      workspaceDir,
      onEvent: (event) => events.push(event),
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({ run: async () => { throw new Error('runner failed'); } }) as never,
        createMemoryManager: async () => null,
      }),
    });

    const caller = app.application.runTurn({
      requestId: 'request-runner-failure',
      sessionKey: 'main',
      message: 'fail execution',
      promptMode: 'full',
    });
    await expect(caller).rejects.toThrow('runner failed');
    expect(events.filter((event) =>
      event.type === 'turn_end' && event.requestId === 'request-runner-failure')).toEqual([
      expect.objectContaining({ outcome: 'failed', failure: expect.any(Object) }),
    ]);
    await app.close();
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
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });
    const failingChannel = createTestChannel('failing-channel');
    failingChannel.channel.send = vi.fn(() => {
      throw new Error('channel failed');
    });
    const receivingChannel = createTestChannel('receiving-channel');
    const receivedEvents = vi.fn();
    receivingChannel.channel.send = receivedEvents;
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [failingChannel.unit, receivingChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
      onAgentEvent: observedEvents,
    });

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

  it('CH-05 isolates an onAgentEvent observer failure from Runner execution', async () => {
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'unreachable',
      content: [{ type: 'text', text: 'unreachable' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolRounds: 0,
    }));
    const observerError = new Error('observer failed');
    const deps = createTestDependencies({
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });
    const testChannel = createTestChannel('observer-failure-channel');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
      onAgentEvent: (event) => {
        if (event.type === 'user_message') throw observerError;
      },
    });
    await expect(testChannel.dispatch({
      sessionKey: 'main',
      message: 'observe',
      clientId: 'client-1',
    })).resolves.toBeUndefined();

    expect(runnerRun).toHaveBeenCalledTimes(1);
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

    expect(app.application.getToolNames()).not.toContain('memory_search');
    expect(events.some((event) => event.type === 'warning')).toBe(true);
    expect(events.some((event) => event.type === 'app_ready')).toBe(true);
  });

  it.each([
    { subagentsEnabled: true, taskExpected: true },
    { subagentsEnabled: false, taskExpected: false },
  ])('publishes one final Snapshot before app_ready when subagents enabled=$subagentsEnabled', async ({
    subagentsEnabled,
    taskExpected,
  }) => {
    const events: RuntimeEvent[] = [];
    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
        subagents: { enabled: subagentsEnabled, maxDepth: 1 },
      },
      dependencies: createTestDependencies(),
      onEvent: (event) => events.push(event),
    });

    const readyEvents = events.filter((event) => event.type === 'app_ready');
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0]?.toolNames).toEqual(app.application.getToolNames());
    expect(readyEvents[0]?.toolNames.includes('task')).toBe(taskExpected);

    await app.close();
  });

  it('emits app_ready only after Channel readiness with final channelIds', async () => {
    const events: RuntimeEvent[] = [];
    const ready = createDeferred<void>();
    const testChannel = createTestChannel('deferred-ready-channel');
    testChannel.channel.start = vi.fn(async () => ready.promise);

    const creation = RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies(),
      onEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => expect(testChannel.channel.start).toHaveBeenCalledTimes(1));
    expect(events.map((event) => event.type)).not.toContain('app_ready');

    ready.resolve();
    const app = await creation;
    expect(events.filter((event) => event.type === 'app_ready')).toEqual([
      expect.objectContaining({ channelIds: ['deferred-ready-channel'] }),
    ]);
    await app.close();
  });

  it('stops activated Channels when app_ready delivery rejects RuntimeApp creation', async () => {
    const observerError = new Error('app_ready observer failed');
    const testChannel = createTestChannel('ready-observer-failure');
    const stop = vi.spyOn(testChannel.channel, 'stop');

    await expect(RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies(),
      onEvent: (event) => {
        if (event.type === 'app_ready') throw observerError;
      },
    })).rejects.toBe(observerError);

    expect(stop).toHaveBeenCalledTimes(1);
    await expect(testChannel.channel.completion).resolves.toEqual({
      outcome: 'closed',
      reason: 'stopped',
    });
  });

  it('cleans Memory exactly once after Builder-side Unit assembly failure', async () => {
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
        getBuiltinContributionUnits: () => {
          throw startupError;
        },
      }),
      onEvent: (event) => events.push(event),
    })).rejects.toBe(startupError);

    expect(events.map((event) => event.type)).toContain('app_start');
    expect(events.map((event) => event.type)).toContain('error');
    expect(events.map((event) => event.type)).not.toContain('app_ready');
    expect(memoryClose).toHaveBeenCalledTimes(1);
  });

  it('bounds nonresponsive Memory cleanup after a bootstrap failure', async () => {
    const deadlineDriver = new ManualDeadlineDriver();
    const memoryClose = vi.fn(() => new Promise<void>(() => undefined));
    const startupError = new Error('runner creation failed');
    const creation = RuntimeApp.create({
      workspaceDir,
      deadlineDriver,
      deadlinePolicy: { candidateCleanupMs: 5_000 },
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: true },
      },
      dependencies: createTestDependencies({
        createMemoryManager: async () => ({ close: memoryClose }) as never,
        createAgentRunner: () => { throw startupError; },
      }),
    });

    await vi.waitFor(() => expect(memoryClose).toHaveBeenCalledTimes(1));
    deadlineDriver.advanceBy(5_000);

    await expect(creation).rejects.toBe(startupError);
  });

  it('fails a missing model before Runner and resolves an explicit model through the Provider', async () => {
    const agentEvents: AgentEvent[] = [];
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
        createAgentRunner: () => ({ run: runnerRun }) as never,
        createMemoryManager: async () => null,
      }),
      onAgentEvent: (event) => agentEvents.push(event),
    });

    await expect(app.application.runTurn({
      sessionKey: 'main',
      message: 'missing model',
      promptMode: 'full',
    })).rejects.toMatchObject({
      info: {
        code: 'MODEL_MISSING',
        resolutionCategory: 'reference_invalid',
        cause: { category: 'reference_invalid' },
      },
    });
    expect(runnerRun).not.toHaveBeenCalled();
    expect(agentEvents.filter((event) => event.type === 'error')).toEqual([]);

    await expect(app.application.runTurn({
      sessionKey: 'main',
      message: 'queued missing model',
      promptMode: 'full',
      turnId: 'queued-resolution-turn',
      originMessageId: 'queued-message',
    })).rejects.toMatchObject({ info: { code: 'MODEL_MISSING' } });
    expect(agentEvents.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        type: 'error',
        sessionKey: 'main',
        turnId: 'queued-resolution-turn',
        category: 'reference_invalid',
        originMessageId: 'queued-message',
      }),
    ]);
    expect(runnerRun).not.toHaveBeenCalled();

    await expect(app.application.runTurn({
      sessionKey: 'main',
      message: 'explicit model',
      promptMode: 'full',
      modelReference: { modelId: 'not-locally-validated' },
      requestOverride: { maxOutputTokens: 2048 },
    })).resolves.toEqual(expect.objectContaining({ text: 'provider accepted model' }));
    expect(runnerRun).toHaveBeenCalledTimes(1);
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedModel: expect.objectContaining({
          identity: { providerId: 'test', modelId: 'not-locally-validated' },
          referenceSource: 'turn-explicit',
          limits: { maxTokens: 2048, maxTokensSource: 'request-override' },
        }),
      }),
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

    const previousVersion = app.application.getState().contextVersion;
    await app.application.reloadContextFiles();
    expect(app.application.getState().contextVersion).toBe(previousVersion + 1);

    await app.close('test shutdown');
    await app.close('test shutdown');

    expect(memoryClose).toHaveBeenCalledTimes(1);
    await expect(app.application.runTurn({ sessionKey: 'main', message: 'after close', promptMode: 'full' })).rejects.toThrow(
      'Cannot run when runtime phase is closed.',
    );
  });

  it('CH-07 rolls back a failed Channel while preserving an independent successful Channel', async () => {
    const startError = new Error('channel start failed');
    const events: RuntimeEvent[] = [];
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
      loadedUnits: [successfulChannel.unit, failingChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          on: () => {},
          run: vi.fn(),
        }) as never,
        createMemoryManager: async () => null,
      }),
      onEvent: (event) => events.push(event),
    });
    expect(successfulChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.start).toHaveBeenCalledTimes(1);
    expect(successfulChannel.channel.stop).not.toHaveBeenCalled();
    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
    await expect(app.application.waitForChannelCompletion('failing-channel')).resolves.toEqual(
      expect.objectContaining({ outcome: 'failed', phase: 'startup', error: startError }),
    );
    expect(events).toContainEqual({
      type: 'warning',
      info: expect.objectContaining({
        code: 'CHANNEL_START_FAILED',
        unitId: 'builtin-test-channel-failing-channel',
        contributionId: 'failing-channel',
        phase: 'start',
      }),
    });

    await app.close();
    expect(successfulChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
  });

  it('CH-08 isolates and reports a Channel stop failure', async () => {
    const failingChannel = createTestChannel('failing-stop-channel');
    const successfulChannel = createTestChannel('successful-stop-channel');
    failingChannel.channel.stop = vi.fn(async () => {
      throw new Error('channel stop failed');
    });
    successfulChannel.channel.stop = vi.fn(async () => {});

    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [failingChannel.unit, successfulChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => ({
          on: () => {},
          run: vi.fn(),
        }) as never,
        createMemoryManager: async () => null,
      }),
    });
    const report = await app.close();

    expect(failingChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(successfulChannel.channel.stop).toHaveBeenCalledTimes(1);
    expect(report.completed.some((resource) =>
      resource.endsWith(':channel:successful-stop-channel'))).toBe(true);
    expect(report.failed).toEqual([
      {
        resource: expect.stringMatching(/:channel:failing-stop-channel$/),
        message: 'channel stop failed',
      },
    ]);
    expect(app.application.getState().phase).toBe('closed');
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
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const testChannel = createTestChannel('queue-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
    });

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
      expect(app.application.getState().activeRunCount).toBe(0);
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
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const testChannel = createTestChannel('steer-test');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
        runner: { inTurnMessageMode: 'steer' },
      },
      dependencies: deps,
    });

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
      let approvalDecision: unknown;

      const runnerRun = vi.fn()
        .mockImplementationOnce(async (): Promise<RunResult> => firstRun.promise)
        .mockImplementationOnce(async (params: RunParams): Promise<RunResult> => {
          if (!params.approvalCapability || !params.signal) {
            throw new Error('Approval capability is missing.');
          }
          const approval = await params.approvalCapability.request({
              callId: 'demo-call',
              toolName: 'demo_tool',
              input: { approval: true },
              turnId: params.turnId,
              sessionKey: params.sessionKey,
            }, params.signal);
          approvalDecision = approval.outcome;
          if (approval.outcome === 'aborted') {
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
        run: runnerRun,
      };

      const deps = createTestDependencies({
        createAgentRunner: () => agentRunner as never,
        createMemoryManager: async () => null,
      });

      const testChannel = createApprovalTestChannel('approval-expiry-queue-test', {
        approvalRequests,
        approvalClosures,
        autoDecision: null,
      });
      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
        },
        dependencies: deps,
      });

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

      expect(app.application.abortTurn('main')).toEqual({ aborted: true, dropped: 0 });
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

  it('fails closed without an origin approval capability independently of Channel startup history', async () => {
    const decisions: unknown[] = [];
    const runnerRun = vi.fn(async (params: RunParams): Promise<RunResult> => {
      decisions.push({
        decision: params.toolPolicy.decide(
          'unmatched_tool',
          params.approvalCapability !== undefined,
        ),
        hasApprovalCapability: params.approvalCapability !== undefined,
      });
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      };
    });
    const agentRunner = {
      run: runnerRun,
    };
    const deps = createTestDependencies({
      createAgentRunner: () => agentRunner as never,
      createMemoryManager: async () => null,
    });
    const testChannel = createTestChannel('no-approval-channel');
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
        tools: { allow: [], deny: [] },
      },
      dependencies: deps,
    });
    await testChannel.dispatch({ sessionKey: 'main', message: 'first request' });
    expect(decisions).toEqual([{ decision: 'deny', hasApprovalCapability: false }]);

    await testChannel.dispatch({ sessionKey: 'main', message: 'second request' });

    expect(decisions).toEqual([
      { decision: 'deny', hasApprovalCapability: false },
      { decision: 'deny', hasApprovalCapability: false },
    ]);
  });

  it('CH-06 shutdown closes a pending approval before waiting for Turn convergence', async () => {
    const approvalRequests: ApprovalRequest[] = [];
    const approvalClosures: Array<{
      request: ApprovalRequest;
      result: ApprovalClosedResult;
    }> = [];

    const agentRunner = {
      run: vi.fn(async (params: RunParams): Promise<RunResult> => {
        if (!params.approvalCapability || !params.signal) {
          throw new Error('Approval capability is missing.');
        }
        const approval = await params.approvalCapability.request({
            callId: 'demo-call',
            toolName: 'demo_tool',
            input: {},
            turnId: params.turnId,
            sessionKey: params.sessionKey,
          }, params.signal);
        if (approval.outcome !== 'aborted') {
          throw new Error('approval unexpectedly settled without shutdown');
        }
        return {
          text: '',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      }),
    };
    const testChannel = createApprovalTestChannel('approval-shutdown-test', {
      approvalRequests,
      approvalClosures,
      autoDecision: null,
    });
    const app = await RuntimeApp.create({
      workspaceDir,
      loadedUnits: [testChannel.unit],
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: createTestDependencies({
        createAgentRunner: () => agentRunner as never,
        createMemoryManager: async () => null,
      }),
    });
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
    async function makeAppWithRunner(runnerRun: (params: unknown) => Promise<RunResult>): Promise<RuntimeHandle> {
      const deps = createTestDependencies({
        createAgentRunner: () => ({ run: runnerRun }) as never,
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

      const result = app2.application.abortTurn('no-such-session');
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
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (e) => events.push(e),
      });

      const turnPromise = app.application.runTurn({ sessionKey: 'main', message: 'go', promptMode: 'full' });

      // 等 runner 收到 signal
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      const abortResult = app.application.abortTurn('main');
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
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('main', [{ dummy: 1 }, { dummy: 2 }, { dummy: 3 }]);

      const result = app.application.abortTurn('main');
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

      const testChannel = createTestChannel('public-abort-test');
      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (e) => events.push(e),
      });
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

      const result = app.application.abortTurn('main');
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

      const testChannel = createTestChannel('steering-abort-test');
      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        cliOverrides: {
          llm: { apiKey: 'test-key', model: 'test-model' },
          memory: { enabled: false },
          runner: { inTurnMessageMode: 'steer' },
        },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
        onEvent: (event) => events.push(event),
        onAgentEvent: (event) => agentEvents.push(event),
      });
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

      expect(app.application.abortTurn('main')).toEqual({ aborted: true, dropped: 0 });
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
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('sk1', [{ x: 1 }]);
      queueMap.set('sk2', [{ y: 1 }, { y: 2 }]);

      const result = app.application.abortTurn('sk1');
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
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeAborts = (app.application as any).activeAborts as Map<string, AbortController>;
      const staleController = new AbortController();
      activeAborts.set('main', staleController);

      await app.application.runTurn({ sessionKey: 'main', message: 'hi', promptMode: 'full' });

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
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
      queueMap.set('main', [{ dummy: 1 }]);

      // API 不该抛，返回值反映真实状态
      const result = app.application.abortTurn('main');
      expect(result).toEqual({ aborted: false, dropped: 1 });
      expect(queueMap.has('main')).toBe(false);

      await app.close();
    });

    // ⑧ CH-08：先 abort active turn，再等待回收；queued request 不启动
    it('CH-08 shutdown aborts the active turn, waits for it, and does not start queued work', async () => {
      const releaseRun = createDeferred<void>();
      const deadlineDriver = new ManualDeadlineDriver();
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

      const testChannel = createTestChannel('shutdown-queue-test');
      const app = await RuntimeApp.create({
        workspaceDir,
        deadlineDriver,
        loadedUnits: [testChannel.unit],
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });
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

      // graceful 阶段不提前 Abort；deadline 后进入独立 Abort convergence。
      await Promise.resolve();
      expect(capturedSignal!.aborted).toBe(false);
      deadlineDriver.advanceBy(30_000);
      await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      releaseRun.resolve();
      await Promise.all([firstDispatch, closePromise]);
      expect(runnerRun).toHaveBeenCalledTimes(1);
    });

    // ⑨ shutdown timing：完全由 monotonic manual deadline 驱动，不依赖 wall-clock sleep
    it('shutdown deadline: responsive signal path aborts after graceful drain and converges', async () => {
      let capturedSignal: AbortSignal | undefined;
      const deadlineDriver = new ManualDeadlineDriver();
      const runnerRun = vi.fn(async (params: { signal?: AbortSignal }): Promise<RunResult> => {
        capturedSignal = params.signal;
        await new Promise<void>((resolve) => {
          if (params.signal?.aborted) return resolve();
          params.signal?.addEventListener('abort', () => resolve());
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
        deadlineDriver,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });

      const turnPromise = app.application.runTurn({ sessionKey: 'main', message: 'go', promptMode: 'full' });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      const closePromise = app.close();
      await Promise.resolve();
      expect(capturedSignal!.aborted).toBe(false);
      deadlineDriver.advanceBy(30_000);
      await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));
      const [, report] = await Promise.all([turnPromise, closePromise]);
      expect(report.outcome).toBe('completed');
    });

    it('queued abort seals one request_end without a turnId', async () => {
      const releaseRun = createDeferred<void>();
      const agentEvents: AgentEvent[] = [];
      const runtimeEvents: RuntimeEvent[] = [];
      const testChannel = createTestChannel('queued-abort-terminal');
      testChannel.channel.send = (event) => { agentEvents.push(event); };
      const runnerRun = vi.fn(async (): Promise<RunResult> => {
        await releaseRun.promise;
        return {
          text: 'done',
          content: [],
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });
      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        onEvent: (event) => runtimeEvents.push(event),
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });

      const active = testChannel.dispatch({ sessionKey: 'main', message: 'active' });
      await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));
      await testChannel.dispatch({ sessionKey: 'main', message: 'queued' });

      expect(app.application.abortTurn('main')).toEqual({ aborted: true, dropped: 1 });
      await vi.waitFor(() => expect(agentEvents.filter((event) => event.type === 'request_end')).toHaveLength(1));
      const agentTerminal = agentEvents.find((event) => event.type === 'request_end');
      expect(agentTerminal).toMatchObject({
        outcome: 'cancelled',
        reason: 'abort_queue_drop',
      });
      expect('turnId' in agentTerminal!).toBe(false);
      expect(runtimeEvents.filter((event) => event.type === 'request_end')).toHaveLength(1);

      releaseRun.resolve();
      await active;
      await app.close();
    });

    it('nonresponsive Root seals once, preserves its pin, and ignores late success', async () => {
      const deadlineDriver = new ManualDeadlineDriver();
      const releaseRun = createDeferred<void>();
      const runtimeEvents: RuntimeEvent[] = [];
      const testChannel = createTestChannel('nonconverged-root');
      const stop = vi.spyOn(testChannel.channel, 'stop');
      const runnerRun = vi.fn(async (): Promise<RunResult> => {
        await releaseRun.promise;
        return {
          text: 'late',
          content: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          toolRounds: 0,
        };
      });
      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        deadlineDriver,
        onEvent: (event) => runtimeEvents.push(event),
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: () => ({ run: runnerRun }) as never,
          createMemoryManager: async () => null,
        }),
      });
      const caller = app.application.runTurn({
        requestId: 'request-nonconverged',
        turnId: 'turn-nonconverged',
        sessionKey: 'main',
        message: 'hang',
        promptMode: 'full',
      });
      const callerSettlement = caller.then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      await vi.waitFor(() => expect(runnerRun).toHaveBeenCalledTimes(1));

      const close = app.close('test shutdown');
      await vi.waitFor(() => expect(deadlineDriver.pendingCount).toBeGreaterThan(0));
      deadlineDriver.advanceBy(30_000);
      await vi.waitFor(() => expect(deadlineDriver.pendingCount).toBeGreaterThan(0));
      deadlineDriver.advanceBy(10_000);
      const report = await close;

      expect(await callerSettlement).toContain('did not converge during shutdown');
      expect(report.outcome).toBe('deadline-exhausted');
      expect(report.turns.nonconvergedRequestIds).toEqual(['request-nonconverged']);
      expect(report.turns.protectedGenerations).toEqual([1]);
      expect(report.instanceStops.skippedProtectedInstanceIds.length).toBeGreaterThan(0);
      expect(stop).not.toHaveBeenCalled();
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.residuals)).toBe(true);
      const sealedResidualCount = report.residuals.length;

      releaseRun.resolve();
      await vi.waitFor(() => expect(app.application.getState().activeRunCount).toBe(0));
      expect(runtimeEvents.filter((event) =>
        event.type === 'turn_end' && event.requestId === 'request-nonconverged')).toHaveLength(1);
      expect(report.residuals).toHaveLength(sealedResidualCount);
      expect(stop).not.toHaveBeenCalled();
    });

    it('nonresponsive terminal Fanout exhausts the shared budget and returns a frozen report', async () => {
      const deadlineDriver = new ManualDeadlineDriver();
      const never = new Promise<void>(() => undefined);
      const testChannel = createTestChannel('nonresponsive-fanout');
      testChannel.channel.send = (event) => event.type === 'run_end' ? never : undefined;
      const runResult: RunResult = {
        text: 'done',
        content: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        toolRounds: 0,
      };
      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        deadlineDriver,
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({
          createAgentRunner: (config) => ({
            run: async (params: RunParams) => {
              config.onEvent?.({
                type: 'run_end',
                requestId: params.requestId ?? params.turnId,
                sessionKey: params.sessionKey,
                turnId: params.turnId,
                result: runResult,
              });
              return runResult;
            },
          }) as never,
          createMemoryManager: async () => null,
        }),
      });
      await app.application.runTurn({
        requestId: 'request-fanout',
        sessionKey: 'main',
        message: 'done',
        promptMode: 'full',
      });

      const close = app.close();
      await vi.waitFor(() => expect(deadlineDriver.pendingCount).toBeGreaterThan(0));
      deadlineDriver.advanceBy(60_000);
      const report = await close;

      expect(report.outcome).toBe('deadline-exhausted');
      expect(report.residuals.some((entry) => entry.owner === 'fanout')).toBe(true);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.instanceStops.pendingInstanceIds)).toBe(true);
    });

    // ⑩ bindAbortHooks wiring：Channel activation 时同步注入 hooks，可查询 & 触发
    it('bindAbortHooks: Channel activation injects querySessionsNeedingAbort + abortTurn', async () => {
      let capturedHooks: { querySessionsNeedingAbort: () => string[]; abortTurn: (sk: string) => { aborted: boolean; dropped: number } } | undefined;
      const testChannel = createTestChannel('abort-hooks-test');
      (testChannel.channel as Channel).bindAbortHooks = (hooks) => {
        capturedHooks = hooks;
      };

      const app = await RuntimeApp.create({
        workspaceDir,
        loadedUnits: [testChannel.unit],
        cliOverrides: { llm: { apiKey: 'test-key', model: 'test-model' }, memory: { enabled: false } },
        dependencies: createTestDependencies({ createMemoryManager: async () => null }),
      });

      expect(capturedHooks).toBeDefined();

      // 塞 queued 消息到某 session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueMap = (app.application as any).messageQueueBySession as Map<string, unknown[]>;
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
  unit: LoadedRuntimeUnit;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  const completion = createDeferred<ChannelCompletion>();
  const channel: Channel = {
    id,
    completion: completion.promise,
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
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    },
  };

  return {
    channel,
    unit: channelUnit(channel),
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
  unit: LoadedRuntimeUnit;
  dispatch(req: ChannelRunRequest): Promise<void>;
} {
  let handler: ((req: ChannelRunRequest) => Promise<void>) | undefined;
  let interactionResponseHandler: Parameters<NonNullable<Channel['interaction']>['onInteractionResponse']>[0] | undefined;
  const autoDecision = options.autoDecision === undefined ? 'allow' : options.autoDecision;
  const completion = createDeferred<ChannelCompletion>();
  const channel: Channel = {
    id,
    completion: completion.promise,
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
      completion.resolve({ outcome: 'closed', reason: 'stopped' });
    },
    interaction: {
      sendInteractionRequest(request) {
        if (request.kind !== 'approval') {
          return { status: 'unavailable', reason: 'delivery_failed' };
        }
        options.approvalRequests.push(request);
        if (autoDecision) {
          interactionResponseHandler?.({
            id: request.id,
            kind: 'approval',
            outcome: 'submitted',
            decision: autoDecision,
          });
        }
        return { status: 'accepted' };
      },
      sendInteractionClosed(request, result) {
        if (request.kind !== 'approval') return;
        options.approvalClosures?.push({ request, result });
      },
      onInteractionResponse(nextHandler) {
        interactionResponseHandler = nextHandler;
      },
      onInteractionUnavailable() {
        // This test channel remains available for its full lifetime.
      },
    },
  };

  return {
    channel,
    unit: channelUnit(channel),
    async dispatch(req: ChannelRunRequest) {
      if (!handler) {
        throw new Error('message handler was not registered');
      }
      await handler(req);
    },
  };
}

function channelUnit(channel: Channel): LoadedRuntimeUnit {
  return createLoadedRuntimeUnit({
    registration: {
    id: `builtin-test-channel-${channel.id}`,
    source: 'builtin',
    register(api) {
      api.registerChannel({ id: channel.id, create: () => channel });
    },
    },
    required: false,
  });
}

function createTestDependencies(
  overrides: Partial<RuntimeDependencies> = {},
): Partial<RuntimeDependencies> {
  const builtinTool: Tool = {
    name: 'demo_tool',
    description: 'Demo tool',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { outcome: 'success', content: 'ok' };
    },
  };

  return {
    createProviderProjection: () => [{
      id: 'test',
      protocol: 'test',
      invocationPort: {} as never,
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
    }],
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
    getBuiltinContributionUnits: () => [builtinUnit(builtinTool)],
    ...overrides,
  };
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