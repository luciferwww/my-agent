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
  prepareError?: Error;
  routeSetError?: Error;
  routeDeleteError?: Error;
  abortDuringPrepare?: boolean;
} = {}) {
  const controller = new AbortController();
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
  const parent: ActiveParentTurn = {
    requestId: 'request-parent',
    sessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
    depth: 0,
    turnId: 'parent-turn',
    signal: controller.signal,
    effectiveReference: { providerId: 'parent', modelId: 'parent-model' },
    effectiveMaxLlmCalls: 6,
    contextFiles: [],
    registrySnapshot,
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
  const events: AgentEvent[] = [];
  const createTransientSubagentTranscript = vi.fn(async () => {});
  const deleteTransientSubagentTranscript = vi.fn(async () => {});
  const prepare = vi.fn(async () => {
    if (options.prepareError) throw options.prepareError;
    if (options.abortDuringPrepare) controller.abort();
    return {
      sessionId: 'ignored-by-test',
      subagentDepth: 1,
      turnId: 'ignored-by-test',
      message: 'child prompt',
      systemPrompt: 'child system',
      signal: controller.signal,
    };
  });
  const execute = vi.fn(async (_prepared, resolvedModel) => {
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
      createTransientSubagentTranscript,
      deleteTransientSubagentTranscript,
    } as never,
    maxDepth: 1,
    executor: { prepare, execute } as never,
    onEvent: (event) => events.push(event),
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
    signal: controller.signal,
  };
  return {
    port,
    request,
    events,
    execute,
    createTransientSubagentTranscript,
    deleteTransientSubagentTranscript,
    controller,
    activeParents,
    routeContextByTurn,
    registerChild,
    releaseChild,
  };
}

describe('Runtime Subagent delegation', () => {
  it('inherits the Parent effective reference but resolves a fresh Child model', async () => {
    const {
      port,
      request,
      events,
      execute,
      deleteTransientSubagentTranscript,
      createTransientSubagentTranscript,
      routeContextByTurn,
      registerChild,
      releaseChild,
    } = setup();
    const result = await port.delegate(request);

    expect(result.text).toBe('parent/parent-model');
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
    expect(createTransientSubagentTranscript).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      callerSessionId: '5cb8b687-f263-4355-9d09-7749064e3318',
    }));
    expect(deleteTransientSubagentTranscript).toHaveBeenCalledTimes(1);
    expect(registerChild).toHaveBeenCalledTimes(1);
    expect(releaseChild).toHaveBeenCalledTimes(1);
    expect([...routeContextByTurn.keys()]).toEqual(['parent-turn']);
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
    const { port, request, events, execute, deleteTransientSubagentTranscript } = setup();
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
    expect(deleteTransientSubagentTranscript).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing Parent before allocating Child lifecycle events', async () => {
    const { port, request, events, execute, activeParents } = setup();
    activeParents.clear();

    await expect(port.delegate(request)).rejects.toBeInstanceOf(SubagentDelegationRejected);
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
    expect(setupCase.deleteTransientSubagentTranscript).toHaveBeenCalledTimes(1);

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
    expect(routeCase.deleteTransientSubagentTranscript).not.toHaveBeenCalled();
    expect(routeCase.execute).not.toHaveBeenCalled();
  });

  it('continues session cleanup when route cleanup fails', async () => {
    const cleanupCase = setup({ routeDeleteError: new Error('route cleanup failed') });
    const result = await cleanupCase.port.delegate(cleanupCase.request);

    expect(result.outcome).toBe('ok');
    expect(cleanupCase.deleteTransientSubagentTranscript).toHaveBeenCalledTimes(1);
    expect(cleanupCase.events.filter((event) => event.type === 'subagent_end')).toHaveLength(1);
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
    expect(abortCase.deleteTransientSubagentTranscript).toHaveBeenCalledTimes(1);
    expect([...abortCase.routeContextByTurn.keys()]).toEqual(['parent-turn']);
  });
});
