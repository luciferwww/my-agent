import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInvocationPort, ModelInvocationRequest } from '../model-invocation/index.js';
import type { CurrentCallApprovalCapability } from '../approval/index.js';
import type { RuntimeContributionUnit } from '../registry/index.js';
import { SessionManager } from '../session/index.js';
import type {
  ApplicationToolPolicy,
  CanonicalToolResult,
  ToolCall,
  ToolExecutionOutput,
} from '../tools/index.js';
import { buildRegistrySnapshot } from '../../runtime/registry-builder.js';
import { AgentRunner } from './AgentRunner.js';

function invocationPort(call: ToolCall, requests: ModelInvocationRequest[]): ModelInvocationPort {
  let round = 0;
  return {
    async *chatStream(request) {
      requests.push(request);
      round++;
      yield { type: 'message_start' as const };
      if (round === 1) {
        yield { type: 'tool_call' as const, call };
        yield {
          type: 'message_end' as const,
          stopReason: 'tool_use',
          usage: { inputTokens: 2, outputTokens: 1 },
        };
        return;
      }
      yield { type: 'text_delta' as const, text: 'done' };
      yield {
        type: 'message_end' as const,
        stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    },
    async chat() {
      throw new Error('not used');
    },
  };
}

function resolvedModel(port: ModelInvocationPort) {
  return {
    identity: { providerId: 'test', modelId: 'test' },
    referenceSource: 'native' as const,
    protocol: 'test',
    endpointId: 'test',
    invocationPort: port,
    facts: {
      effectiveContextLimit: { value: 200_000, source: 'deployment-config' as const },
      maximumOutputTokens: { value: 4096, source: 'deployment-config' as const },
      toolUse: { value: true, source: 'deployment-config' as const },
    },
    limits: { maxTokens: 4096, maxTokensSource: 'policy-default' as const },
  };
}

const allowPolicy: ApplicationToolPolicy = Object.freeze({
  isDenied: () => false,
  decide: () => 'allow' as const,
});

describe('AgentRunner canonical Tool pipeline', () => {
  let workspaceDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'tool-pipeline-'));
    sessionManager = new SessionManager(workspaceDir);
    await sessionManager.createSession('main');
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('pairs malformed input without invoking Hook, policy, approval, or Tool', async () => {
    const before = vi.fn(() => ({ action: 'allow' as const }));
    const afterResults: CanonicalToolResult[] = [];
    const execute = vi.fn(async (): Promise<ToolExecutionOutput> => ({ outcome: 'success', content: 'executed' }));
    const policyDecision = vi.fn(() => 'allow' as const);
    const approvalRequest = vi.fn(async () => ({ outcome: 'approved' as const }));
    const snapshot = snapshotWithTool({ before, afterResults, execute });
    const requests: ModelInvocationRequest[] = [];
    const port = invocationPort({
      callId: 'malformed-call',
      name: 'demo',
      input: { state: 'invalid', reason: 'malformed_json' },
    }, requests);

    await new AgentRunner({ sessionManager }).run({
      sessionKey: 'main',
      message: 'go',
      systemPrompt: '',
      turnId: 'turn',
      resolvedModel: resolvedModel(port),
      toolProjection: snapshot.tools,
      hookProjection: snapshot.hooks,
      toolPolicy: { isDenied: () => false, decide: policyDecision },
      approvalCapability: { request: approvalRequest },
    });

    expect(before).not.toHaveBeenCalled();
    expect(policyDecision).not.toHaveBeenCalled();
    expect(approvalRequest).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(afterResults).toEqual([{
      callId: 'malformed-call',
      outcome: 'invalid_input',
      content: 'Invalid input for tool "demo": malformed_json.',
    }]);
    expect(requests).toHaveLength(2);
  });

  it('validates only the final transformed input before policy and execution', async () => {
    const policyDecision = vi.fn(() => 'allow' as const);
    const execute = vi.fn(async (): Promise<ToolExecutionOutput> => ({ outcome: 'success', content: 'executed' }));
    const afterResults: CanonicalToolResult[] = [];
    const snapshot = snapshotWithTool({
      before: () => ({ action: 'allow', input: { count: 'not-a-number' } }),
      afterResults,
      execute,
    });
    const port = invocationPort({
      callId: 'transformed-call',
      name: 'demo',
      input: { state: 'ready', value: { count: 2 } },
    }, []);

    await new AgentRunner({ sessionManager }).run({
      sessionKey: 'main',
      message: 'go',
      systemPrompt: '',
      turnId: 'turn',
      resolvedModel: resolvedModel(port),
      toolProjection: snapshot.tools,
      hookProjection: snapshot.hooks,
      toolPolicy: { isDenied: () => false, decide: policyDecision },
    });

    expect(policyDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(afterResults[0]).toEqual(expect.objectContaining({
      callId: 'transformed-call',
      outcome: 'invalid_input',
    }));
  });

  it('hides an explicit-deny definition and still denies a stale Provider call at runtime', async () => {
    const afterResults: CanonicalToolResult[] = [];
    const execute = vi.fn(async (): Promise<ToolExecutionOutput> => ({ outcome: 'success', content: 'executed' }));
    const snapshot = snapshotWithTool({
      before: () => ({ action: 'allow' }),
      afterResults,
      execute,
    });
    const policy: ApplicationToolPolicy = Object.freeze({
      isDenied: (name: string) => name === 'demo',
      decide: () => 'deny',
    });
    const requests: ModelInvocationRequest[] = [];
    const port = invocationPort({
      callId: 'stale-call',
      name: 'demo',
      input: { state: 'ready', value: { count: 1 } },
    }, requests);

    await new AgentRunner({ sessionManager }).run({
      sessionKey: 'main',
      message: 'go',
      systemPrompt: '',
      turnId: 'turn',
      resolvedModel: resolvedModel(port),
      toolProjection: snapshot.tools,
      hookProjection: snapshot.hooks,
      toolPolicy: policy,
    });

    expect(requests[0]?.tools).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(afterResults[0]).toEqual(expect.objectContaining({
      callId: 'stale-call',
      outcome: 'denied',
    }));
  });

  it.each([
    [{ outcome: 'denied', reason: 'user' } as const, 'denied'],
    [{ outcome: 'unavailable', reason: 'origin_disconnected' } as const, 'unavailable'],
    [{ outcome: 'failed', message: 'transport failed' } as const, 'failed'],
  ])('preserves approval outcome %j as canonical %s', async (approval, expectedOutcome) => {
    const afterResults: CanonicalToolResult[] = [];
    const execute = vi.fn(async (): Promise<ToolExecutionOutput> => ({ outcome: 'success', content: 'executed' }));
    const snapshot = snapshotWithTool({
      before: () => ({ action: 'allow' }),
      afterResults,
      execute,
    });
    const capability: CurrentCallApprovalCapability = {
      request: vi.fn(async () => approval),
    };
    const port = invocationPort({
      callId: 'approval-call',
      name: 'demo',
      input: { state: 'ready', value: { count: 1 } },
    }, []);

    await new AgentRunner({ sessionManager }).run({
      sessionKey: 'main',
      message: 'go',
      systemPrompt: '',
      turnId: 'turn',
      resolvedModel: resolvedModel(port),
      toolProjection: snapshot.tools,
      hookProjection: snapshot.hooks,
      toolPolicy: { isDenied: () => false, decide: () => 'requires_approval' },
      approvalCapability: capability,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(afterResults[0]).toEqual(expect.objectContaining({
      callId: 'approval-call',
      outcome: expectedOutcome,
    }));
  });

  it('persists the complete Tool exchange before after observers settle', async () => {
    let releaseObserver!: () => void;
    const observerBarrier = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const observerEntered = vi.fn();
    const snapshot = snapshotWithTool({
      before: () => ({ action: 'allow' }),
      afterResults: [],
      execute: async () => ({ outcome: 'success', content: 'executed' }),
      after: async () => {
        observerEntered();
        await observerBarrier;
      },
    });
    const appendMessage = vi.spyOn(sessionManager, 'appendMessage');
    const requests: ModelInvocationRequest[] = [];
    const port = invocationPort({
      callId: 'observed-call',
      name: 'demo',
      input: { state: 'ready', value: { count: 1 } },
    }, requests);

    const runPromise = new AgentRunner({ sessionManager }).run({
      sessionKey: 'main',
      message: 'go',
      systemPrompt: '',
      turnId: 'turn',
      resolvedModel: resolvedModel(port),
      toolProjection: snapshot.tools,
      hookProjection: snapshot.hooks,
      toolPolicy: allowPolicy,
    });

    await vi.waitFor(() => expect(observerEntered).toHaveBeenCalledTimes(1));
    expect(appendMessage).toHaveBeenCalledWith('main', expect.objectContaining({
      role: 'toolResult',
    }));
    expect(requests).toHaveLength(1);

    releaseObserver();
    await runPromise;
    expect(requests).toHaveLength(2);
  });

  it('settles after observers before reporting Tool-result persistence failure', async () => {
    let releaseObserver!: () => void;
    const observerBarrier = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const observerEntered = vi.fn();
    const snapshot = snapshotWithTool({
      before: () => ({ action: 'allow' }),
      afterResults: [],
      execute: async () => ({ outcome: 'success', content: 'executed' }),
      after: async () => {
        observerEntered();
        await observerBarrier;
      },
    });
    vi.spyOn(sessionManager, 'appendMessage').mockImplementation(async (_sessionKey, message) => {
      if (message.role === 'toolResult') throw new Error('persistence failed');
      return 'entry-id';
    });
    const port = invocationPort({
      callId: 'persistence-call',
      name: 'demo',
      input: { state: 'ready', value: { count: 1 } },
    }, []);

    const runPromise = new AgentRunner({ sessionManager }).run({
      sessionKey: 'main',
      message: 'go',
      systemPrompt: '',
      turnId: 'turn',
      resolvedModel: resolvedModel(port),
      toolProjection: snapshot.tools,
      hookProjection: snapshot.hooks,
      toolPolicy: allowPolicy,
    });
    let settled = false;
    void runPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.waitFor(() => expect(observerEntered).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseObserver();
    await expect(runPromise).rejects.toThrow('persistence failed');
  });
});

function snapshotWithTool(options: {
  before: (...args: never[]) => unknown;
  afterResults: CanonicalToolResult[];
  execute: (input: Record<string, unknown>) => Promise<ToolExecutionOutput>;
  after?: () => void | Promise<void>;
}) {
  const unit: RuntimeContributionUnit = {
    id: 'builtin-test-tool',
    source: 'builtin',
    register(api) {
      api.registerTool({
        name: 'demo',
        description: 'Demo tool',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
          additionalProperties: false,
        },
        execute: options.execute,
      });
      api.registerHook({
        id: 'before-demo',
        hookName: 'before_tool_call',
        handler: options.before as never,
      });
      api.registerHook({
        id: 'after-demo',
        hookName: 'after_tool_call',
        handler: async ({ result }) => {
          options.afterResults.push(result);
          await options.after?.();
        },
      });
    },
  };
  return buildRegistrySnapshot({ providers: [], units: [unit] });
}
