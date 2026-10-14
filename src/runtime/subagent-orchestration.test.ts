import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionFailure } from '../core/runner/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import type { ModelInvocationPort } from '../core/model-invocation/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';
import { finalizeRegistrySnapshot } from './registry-builder.js';
import type { SubagentProfile } from '../core/subagent/types.js';
import {
  createSubagentDelegationPort,
  SubagentDelegationRejected,
  type ActiveParentTurn,
} from './subagent-orchestration.js';

const invocationPorts: Record<string, ModelInvocationPort> = {
  parent: {
    chatStream: vi.fn(async function* () { throw new Error('not called'); }),
    chat: vi.fn(async () => { throw new Error('not called'); }),
  },
  child: {
    chatStream: vi.fn(async function* () { throw new Error('not called'); }),
    chat: vi.fn(async () => { throw new Error('not called'); }),
  },
};

function provider(id: string): ProviderProjectionEntry {
  return {
    id,
    protocol: `${id}-protocol`,
    models: [{ modelId: `${id}-model` }],
    invocationPort: invocationPorts[id]!,
    resolveConnection: () => ({ ok: true, connection: { endpointId: `${id}-endpoint` } }),
    resolveModel: (modelId, connection) => ({
      ok: true,
      descriptor: {
        identity: { providerId: id, modelId },
        protocol: `${id}-protocol`,
        connection,
        facts: {
          effectiveContextLimit: id === 'parent' ? 1000 : 2000,
          maximumOutputTokens: 100,
        },
      },
    }),
  };
}

function profile(model: SubagentProfile['model'] = 'inherit'): SubagentProfile {
  return {
    id: 'reviewer',
    description: 'review',
    agentDir: '/missing-profile-dir',
    model,
  };
}

function setup(options: {
  executeError?: Error;
  executeGate?: Promise<void>;
  prepareError?: Error;
  routeSetError?: Error;
  routeDeleteError?: Error;
  retainError?: Error;
  abortDuringPrepare?: boolean;
} = {}) {
  const controller = new AbortController();
  const executionController = new AbortController();
  const registrySnapshot = finalizeRegistrySnapshot({
    generation: 1,
    candidate: {
      providers: [provider('parent'), provider('child')],
      units: [],
      diagnostics: [],
    },
    acceptedUnits: [],
    channelBindings: [],
  });
  const releaseChild = vi.fn();
  const registerChild = vi.fn(() => releaseChild);
  const approvalCapability = { request: vi.fn() };
  const parent: ActiveParentTurn = {
    requestId: 'request-parent',
    sessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
    depth: 0,
    turnId: 'parent-turn',
    signal: controller.signal,
    effectiveReference: { providerId: 'parent', modelId: 'parent-model' },
    contextFiles: [],
    registrySnapshot,
    approvalCapability,
    getSessionPermissionMode: () => 'manual',
    registerChild,
  };
  const activeParents = new Map([[parent.turnId, parent]]);
  const routeContextByTurn = new Map([['parent-turn', { originClientId: 'client-1' }]]);
  if (options.routeSetError) {
    vi.spyOn(routeContextByTurn, 'set').mockImplementationOnce(() => {
      throw options.routeSetError;
    });
  }
  if (options.routeDeleteError) {
    vi.spyOn(routeContextByTurn, 'delete').mockImplementationOnce(() => {
      throw options.routeDeleteError;
    });
  }
  const lifecycleOperations: string[] = [];
  const events: AgentEvent[] = [];
  const registerPreparingSubagentSession = vi.fn(() => {
    lifecycleOperations.push('register-preparing');
  });
  const clearPreparingSubagentSession = vi.fn(() => {
    lifecycleOperations.push('clear-preparing');
  });
  const createTransientSubagentTranscript = vi.fn(async () => {
    lifecycleOperations.push('create-transcript');
  });
  const retainTransientSubagentTranscript = vi.fn(async () => {
    lifecycleOperations.push('retain-transcript');
    if (options.retainError) throw options.retainError;
  });
  const prepare = vi.fn(async (params: { signal: AbortSignal }) => {
    if (options.prepareError) throw options.prepareError;
    if (options.abortDuringPrepare) executionController.abort();
    return {
      sessionId: 'ignored-by-test',
      subagentDepth: 1,
      turnId: 'ignored-by-test',
      message: 'child prompt',
      systemPrompt: 'child system',
      signal: params.signal,
    };
  });
  const execute = vi.fn(async (_prepared, resolvedModel) => {
    if (options.executeGate) await options.executeGate;
    if (options.executeError) throw options.executeError;
    return {
      text: `${resolvedModel.identity.providerId}/${resolvedModel.identity.modelId}`,
      content: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: 2 },
      toolRounds: 0,
    };
  });
  const port = createSubagentDelegationPort({
    activeParents,
    routeContextByTurn,
    sessionManager: {
      registerPreparingSubagentSession,
      clearPreparingSubagentSession,
      createTransientSubagentTranscript,
      retainTransientSubagentTranscript,
    } as never,
    maxDepth: 1,
    maxLlmCallsPerTurn: 6,
    executor: { prepare, execute } as never,
    onEvent: (event) => {
      lifecycleOperations.push(event.type);
      events.push(event);
    },
  });
  const request = {
    profile: profile(),
    description: 'review',
    prompt: 'child prompt',
    parent: {
      sessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
      turnId: 'parent-turn',
      toolUseId: 'tool-1',
    },
    parentSignal: controller.signal,
    signal: executionController.signal,
    reportActivity: vi.fn(),
  };
  return {
    port,
    request,
    events,
    execute,
    registerPreparingSubagentSession,
    clearPreparingSubagentSession,
    createTransientSubagentTranscript,
    retainTransientSubagentTranscript,
    controller,
    executionController,
    activeParents,
    routeContextByTurn,
    registerChild,
    releaseChild,
    lifecycleOperations,
    prepare,
    parent,
  };
}

describe('Runtime Subagent delegation', () => {
  it('inherits the Parent effective reference but resolves a fresh Child model', async () => {
    const {
      port,
      request,
      events,
      execute,
      retainTransientSubagentTranscript,
      createTransientSubagentTranscript,
      registerPreparingSubagentSession,
      lifecycleOperations,
      routeContextByTurn,
      registerChild,
      releaseChild,
      prepare,
      parent,
    } = setup();
    const result = await port.delegate(request);

    expect(result.text).toBe('parent/parent-model');
    expect(request.reportActivity).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![1].identity).toEqual({
      providerId: 'parent',
      modelId: 'parent-model',
    });

    expect(events.map((event) => event.type)).toEqual(['subagent_start', 'subagent_end']);
    expect(events[0]).toEqual(expect.objectContaining({
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      callerSessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
      parentTurnId: 'parent-turn',
      parentToolUseId: 'tool-1',
    }));
    expect(registerPreparingSubagentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      callerSessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
    }));
    expect(registerPreparingSubagentSession.mock.invocationCallOrder[0])
      .toBeLessThan(createTransientSubagentTranscript.mock.invocationCallOrder[0]!);
    expect(lifecycleOperations.slice(0, 3)).toEqual([
      'register-preparing',
      'subagent_start',
      'create-transcript',
    ]);
    expect(createTransientSubagentTranscript).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      callerSessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
    }));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      approvalCapability: parent.approvalCapability,
      maxLlmCallsPerTurn: 6,
    }));
    expect(retainTransientSubagentTranscript).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'ok',
    );
    expect(events.at(-1)?.type).toBe('subagent_end');
    expect(lifecycleOperations.indexOf('subagent_end'))
      .toBeLessThan(lifecycleOperations.indexOf('retain-transcript'));
    expect(registerChild).toHaveBeenCalledTimes(1);
    expect(releaseChild).toHaveBeenCalledTimes(1);
    expect([...routeContextByTurn.keys()]).toEqual(['parent-turn']);
  });

  it('validates Parent authority while using execution-local cancellation for the Child', async () => {
    const {
      port,
      request,
      parent,
      executionController,
      prepare,
    } = setup();

    await expect(port.delegate(request)).resolves.toMatchObject({ outcome: 'ok' });
    expect(request.parentSignal).toBe(parent.signal);
    expect(request.signal).toBe(executionController.signal);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      signal: executionController.signal,
    }));
  });

  it('runs sibling delegations concurrently with independent Child lifecycles', async () => {
    let releaseExecution!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const subject = setup({ executeGate });
    const siblingController = new AbortController();

    const first = subject.port.delegate(subject.request);
    const second = subject.port.delegate({
      ...subject.request,
      parent: {
        ...subject.request.parent,
        toolUseId: 'tool-2',
      },
      signal: siblingController.signal,
    });

    await vi.waitFor(() => {
      expect(subject.execute).toHaveBeenCalledTimes(2);
    });
    expect(subject.events.filter((event) => event.type === 'subagent_start')).toHaveLength(2);
    expect(subject.registerChild).toHaveBeenCalledTimes(2);
    expect(new Set(subject.execute.mock.calls.map(([prepared]) => prepared.signal)).size).toBe(2);

    releaseExecution();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: 'ok' }),
      expect.objectContaining({ outcome: 'ok' }),
    ]);

    const starts = subject.events.filter((event) => event.type === 'subagent_start');
    expect(new Set(starts.map((event) => event.sessionId)).size).toBe(2);
    expect(subject.releaseChild).toHaveBeenCalledTimes(2);
    expect(subject.retainTransientSubagentTranscript).toHaveBeenCalledTimes(2);
    expect([...subject.routeContextByTurn.keys()]).toEqual(['parent-turn']);
  });

  it('uses a concrete Child Provider/Model independently of Parent selection', async () => {
    const { port, request, execute } = setup();
    const result = await port.delegate({
      ...request,
      profile: profile({ providerId: 'child', modelId: 'child-model' }),
    });

    expect(result.text).toBe('child/child-model');
    expect(execute.mock.calls[0]![1].identity).toEqual({
      providerId: 'child',
      modelId: 'child-model',
    });
    expect(execute.mock.calls[0]![1]).toEqual(expect.objectContaining({
      protocol: 'child-protocol',
      endpointId: 'child-endpoint',
      invocationPort: invocationPorts.child,
      facts: expect.objectContaining({
        effectiveContextLimit: 2000,
      }),
    }));
  });

  it('terminalizes resolution failure with its category and never executes the Child', async () => {
    const { port, request, events, execute, retainTransientSubagentTranscript } = setup();
    const result = await port.delegate({
      ...request,
      profile: profile({ providerId: 'missing', modelId: 'child-model' }),
    });

    expect(result).toEqual(expect.objectContaining({
      outcome: 'error',
      failure: expect.objectContaining({
        phase: 'resolution',
        category: 'provider_unregistered',
      }),
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(invocationPorts.parent!.chatStream).not.toHaveBeenCalled();
    expect(invocationPorts.parent!.chat).not.toHaveBeenCalled();
    expect(invocationPorts.child!.chatStream).not.toHaveBeenCalled();
    expect(invocationPorts.child!.chat).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['subagent_start', 'subagent_end']);
    expect(retainTransientSubagentTranscript).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing Parent before allocating Child lifecycle events', async () => {
    const { port, request, events, execute, activeParents } = setup();
    activeParents.clear();

    await expect(port.delegate(request)).rejects.toBeInstanceOf(SubagentDelegationRejected);
    expect(events).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a mismatched Parent authority signal before allocating Child lifecycle', async () => {
    const { port, request, events, execute } = setup();

    await expect(port.delegate({
      ...request,
      parentSignal: new AbortController().signal,
    })).rejects.toBeInstanceOf(SubagentDelegationRejected);
    expect(events).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('terminalizes setup and typed execution failures exactly once with acquired cleanup', async () => {
    const setupCase = setup({ prepareError: new Error('prompt failed') });
    const setupResult = await setupCase.port.delegate(setupCase.request);
    expect(setupResult).toEqual(expect.objectContaining({
      outcome: 'error',
      failure: { phase: 'setup', message: 'prompt failed' },
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    expect(setupCase.events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
    expect(setupCase.retainTransientSubagentTranscript).toHaveBeenCalledTimes(1);

    const executionCase = setup({
      executeError: new AgentExecutionFailure('provider failed', {
        inputTokens: 9,
        outputTokens: 3,
      }),
    });
    const executionResult = await executionCase.port.delegate(executionCase.request);
    expect(executionResult).toEqual(expect.objectContaining({
      outcome: 'error',
      failure: { phase: 'execution', message: 'provider failed' },
      usage: { inputTokens: 9, outputTokens: 3 },
    }));
    expect(executionCase.events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
  });

  it('terminalizes route registration failure without allocating a session', async () => {
    const routeCase = setup({ routeSetError: new Error('route failed') });
    const result = await routeCase.port.delegate(routeCase.request);

    expect(result).toEqual(expect.objectContaining({
      outcome: 'error',
      failure: { phase: 'setup', message: 'route failed' },
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    expect(routeCase.events.map((event) => event.type)).toEqual([
      'subagent_start',
      'subagent_end',
    ]);
    expect(routeCase.retainTransientSubagentTranscript).not.toHaveBeenCalled();
    expect(routeCase.clearPreparingSubagentSession).toHaveBeenCalledTimes(1);
    expect(routeCase.execute).not.toHaveBeenCalled();
  });

  it('continues session cleanup when route cleanup fails', async () => {
    const cleanupCase = setup({ routeDeleteError: new Error('route cleanup failed') });
    const result = await cleanupCase.port.delegate(cleanupCase.request);

    expect(result.outcome).toBe('ok');
    expect(cleanupCase.retainTransientSubagentTranscript).toHaveBeenCalledTimes(1);
    expect(cleanupCase.events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
  });

  it('preserves the terminal result when Transcript retention fails', async () => {
    const retentionCase = setup({ retainError: new Error('retention failed') });

    const result = await retentionCase.port.delegate(retentionCase.request);

    expect(result).toEqual(expect.objectContaining({
      outcome: 'ok',
      text: 'parent/parent-model',
    }));
    expect(retentionCase.events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
    expect(retentionCase.retainTransientSubagentTranscript).toHaveBeenCalledTimes(1);
  });

  it('uses the Parent signal and reports Abort without execution failure', async () => {
    const { port, request, controller, events } = setup({
      prepareError: new DOMException('Aborted', 'AbortError'),
    });
    controller.abort();
    await expect(port.delegate(request)).rejects.toBeInstanceOf(SubagentDelegationRejected);
    expect(events).toEqual([]);
  });

  it('terminalizes Abort during accepted Child setup and cleans acquired resources', async () => {
    const abortCase = setup({ abortDuringPrepare: true });
    const result = await abortCase.port.delegate(abortCase.request);

    expect(result).toEqual(expect.objectContaining({
      outcome: 'aborted',
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    expect(result.failure).toBeUndefined();
    expect(abortCase.events.map((event) => event.type)).toEqual([
      'subagent_start',
      'subagent_end',
    ]);
    expect(abortCase.execute).not.toHaveBeenCalled();
    expect(abortCase.retainTransientSubagentTranscript).toHaveBeenCalledTimes(1);
    expect([...abortCase.routeContextByTurn.keys()]).toEqual(['parent-turn']);
  });
});
