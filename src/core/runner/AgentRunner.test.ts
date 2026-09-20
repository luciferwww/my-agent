import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentRunner as ProductionAgentRunner } from './AgentRunner.js';
import { AgentExecutionFailure } from './errors.js';
import { SessionManager } from '../session/SessionManager.js';
import type {
  ChatContentBlock,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent as ModelStreamEvent,
} from '../model-invocation/index.js';
import { compilePortableToolSchema } from '../tools/portable-schema.js';
import type {
  ApplicationToolPolicy,
  ToolExecutionContext,
  ToolDefinition,
  ToolResult,
} from '../tools/types.js';
import type { HookName, HookHandlerMap, HookRegistration } from './hooks/index.js';
import type { HookProjection, ToolProjection } from '../registry/index.js';
import type { AgentEvent, AgentRunnerConfig, RunParams, RunResult } from './types.js';

type LegacyTestRunParams = Omit<
  RunParams,
  'resolvedModel' | 'toolProjection' | 'hookProjection' | 'toolPolicy'
> & {
  model: string;
  contextWindowTokens?: number;
  tools?: ToolDefinition[];
};

type LegacyTestRunnerConfig = AgentRunnerConfig & {
  llmClient: ModelInvocationPort;
  toolExecutor?: ToolExecutor;
};

type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

const MAIN_SESSION_ID = '00000000-0000-4000-8000-000000000101';
const CHILD_SESSION_ID = '00000000-0000-4000-8000-000000000102';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000103';
const CONCURRENT_SESSION_ID = '00000000-0000-4000-8000-000000000104';

async function createEmptyTestSession(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<void> {
  await sessionManager.materializeSession({
    sessionId,
    createdAt: Date.now(),
  });
}

const allowAllTools: ApplicationToolPolicy = Object.freeze({
  isDenied: () => false,
  decide: () => 'allow' as const,
});

const permissiveValidator = compilePortableToolSchema({
  type: 'object',
  additionalProperties: true,
});

/** Test-only fixture adapter; production Runner has no legacy input path. */
class AgentRunner extends ProductionAgentRunner {
  private readonly testInvocationPort: ModelInvocationPort;
  private readonly testToolExecutor?: ToolExecutor;
  private readonly testHooks: HookRegistration[] = [];

  constructor(config: LegacyTestRunnerConfig) {
    const { llmClient, toolExecutor, ...runnerConfig } = config;
    super(runnerConfig);
    this.testInvocationPort = llmClient;
    this.testToolExecutor = toolExecutor;
  }

  on<K extends HookName>(
    hookName: K,
    handler: HookHandlerMap[K],
    options?: { priority?: number; name?: string },
  ): this {
    this.testHooks.push({
      hookName,
      handler,
      priority: options?.priority ?? 0,
      name: options?.name,
    } as HookRegistration);
    return this;
  }

  override run(params: RunParams | LegacyTestRunParams): Promise<RunResult> {
    if ('resolvedModel' in params) {
      return super.run(params);
    }
    const { model, contextWindowTokens, tools = [], ...rest } = params;
    const toolProjection = this.makeToolProjection(tools);
    return super.run({
      ...rest,
      toolProjection,
      hookProjection: this.makeHookProjection(),
      toolPolicy: allowAllTools,
      resolvedModel: {
        identity: { providerId: 'test', modelId: model },
        referenceSource: 'native',
        protocol: 'test',
        endpointId: 'test',
        invocationPort: this.testInvocationPort,
        facts: {
          effectiveContextLimit: contextWindowTokens ?? 200_000,
          maximumOutputTokens: 1_000_000,
          toolUse: true,
          mediaKinds: ['image'],
        },
      },
    });
  }

  private makeToolProjection(definitions: readonly ToolDefinition[]): ToolProjection {
    const executor = this.testToolExecutor;
    return Object.freeze({
      definitions,
      resolve(name: string) {
        if (!executor) return undefined;
        const definition = definitions.find((candidate) => candidate.name === name) ?? {
          name,
          description: '',
          inputSchema: permissiveValidator.schema,
        };
        return Object.freeze({
          unitId: 'test-tools',
          definition,
          validator: permissiveValidator,
          execute: async (input: Record<string, unknown>, context: ToolExecutionContext) => {
            const result = await executor(name, input, context);
            return {
              outcome: result.isError ? 'failed' as const : 'success' as const,
              content: result.content,
            };
          },
        });
      },
      visibleDefinitions() {
        return definitions;
      },
    });
  }

  private makeHookProjection(): HookProjection {
    const bindings = <K extends HookName>(hookName: K) => this.testHooks
      .filter((registration) => registration.hookName === hookName)
      .sort((left, right) => right.priority - left.priority)
      .map((registration, index) => ({
        unitId: 'test-hooks',
        contributionId: registration.name ?? `${hookName}-${index}`,
        hookName,
        priority: registration.priority,
        handler: registration.handler as HookHandlerMap[K],
      }));
    return Object.freeze({
      beforeToolCall: Object.freeze(bindings('before_tool_call')),
      afterToolCall: Object.freeze(bindings('after_tool_call')),
      beforeCompaction: Object.freeze(bindings('before_compaction')),
      afterCompaction: Object.freeze(bindings('after_compaction')),
    });
  }
}

// ── Mock ModelInvocationPort ────────────────────────────

type LegacyTestStreamEvent = ModelStreamEvent | {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

function createMockLLMClient(responses: LegacyTestStreamEvent[][]): ModelInvocationPort {
  let callIndex = 0;
  return {
    async *chatStream(): AsyncIterable<ModelStreamEvent> {
      const events = responses[callIndex++] ?? [];
      for (const event of events) {
        yield event.type === 'tool_use'
          ? {
              type: 'tool_call',
              call: {
                callId: event.id,
                name: event.name,
                input: { state: 'ready', value: event.input },
              },
            }
          : event;
      }
    },
    async chat(): Promise<ModelInvocationResponse> {
      throw new Error('Not used in tests');
    },
  };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('newly materialized Session', () => {
  it('persists the Runner message exactly once in the Transcript and Provider input', async () => {
    const agentHome = await mkdtemp(join(tmpdir(), 'runner-materialized-test-'));
    try {
      const sessionManager = new SessionManager(agentHome);
      const sessionId = '00000000-0000-4000-8000-000000000001';
      await sessionManager.materializeSession({
        sessionId,
        createdAt: Date.now(),
      });
      let providerMessages: ModelInvocationRequest['messages'] = [];
      const llmClient: ModelInvocationPort = {
        async *chatStream(request: ModelInvocationRequest) {
          providerMessages = request.messages.map((message) => ({ ...message }));
          yield { type: 'message_start' } as ModelStreamEvent;
          yield { type: 'text_delta', text: 'done' } as ModelStreamEvent;
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          } as ModelStreamEvent;
        },
        async chat() {
          throw new Error('Not used');
        },
      };

      await new AgentRunner({ llmClient, sessionManager }).run({
        sessionId: sessionId,
        message: 'materialized once',
        model: 'test',
        systemPrompt: '',
        turnId: 'materialized-turn',
      });

      const persistedUsers = sessionManager.getMessages(sessionId)
        .filter(({ message }) => message.role === 'user');
      const providerUsers = providerMessages.filter((message) => message.role === 'user');
      expect(persistedUsers).toHaveLength(1);
      expect(providerUsers).toEqual([{ role: 'user', content: 'materialized once' }]);
    } finally {
      await rm(agentHome, { recursive: true, force: true });
    }
  });
});

// ── Tests ───────────────────────────────────────────────

describe('AgentRunner', () => {
  let agentHome: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'runner-test-'));
    sessionManager = new SessionManager(agentHome);
    await createEmptyTestSession(sessionManager, MAIN_SESSION_ID);
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  // ── Basic conversation ──────────────────────────────

  describe('basic conversation', () => {
    it('handles simple text response', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Hello!' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      ]);

      const runner = new AgentRunner({ llmClient, sessionManager });
      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: 'You are helpful.',
        turnId: 'test-turn',
      });

      expect(result.text).toBe('Hello!');
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.toolRounds).toBe(0);
    });

    it('preserves multi-turn conversation history', async () => {
      let capturedMessages: ModelInvocationRequest['messages'] = [];

      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          capturedMessages = params.messages.map(m => ({ ...m }));
          yield { type: 'message_start' } as ModelStreamEvent;
          yield { type: 'text_delta', text: 'Response' } as ModelStreamEvent;
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } as ModelStreamEvent;
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });

      // First Turn.
      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'First', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      // The second Turn should see the first Turn's history.
      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Second', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      // Expected: user(First) + assistant(Response) + user(Second).
      expect(capturedMessages[0]!.content).toBe('First');
      expect(capturedMessages[capturedMessages.length - 1]!.content).toBe('Second');
      // The assistant response remains between the user messages.
      const assistantMsg = capturedMessages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
    });

    it('handles empty response', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 0 } },
        ],
      ]);

      const runner = new AgentRunner({ llmClient, sessionManager });
      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      expect(result.text).toBe('');
      expect(result.content).toHaveLength(0);
    });
  });

  // ── Tool use loop ──────────────────────────────────

  describe('tool use loop', () => {
    it('executes single tool call and continues', async () => {
      const llmClient = createMockLLMClient([
        // First round: the LLM requests a tool.
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'get_weather', input: { city: 'Tokyo' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 10 } },
        ],
        // Second round: the LLM responds after receiving the tool result.
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'The weather in Tokyo is sunny.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 15 } },
        ],
      ]);

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'Sunny, 25°C' }),
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Weather?',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: {} }],
      });

      expect(result.text).toBe('The weather in Tokyo is sunny.');
      expect(result.toolRounds).toBe(1);
      expect(result.usage.inputTokens).toBe(50);
      expect(result.usage.outputTokens).toBe(25);
    });

    it('handles multiple tool rounds', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'tool_a', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_02', name: 'tool_b', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } },
        ],
      ]);

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async (name) => ({ content: `Result of ${name}` }),
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Do tasks',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      expect(result.text).toBe('Done.');
      expect(result.toolRounds).toBe(2);
    });

    it('passes ToolExecutionContext (sessionId/turnId/callId) to the test executor', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_ctx_42', name: 'inspect', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      ]);

      const seen: Array<{ name: string; ctx: unknown }> = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async (name, _input, ctx) => {
          seen.push({ name, ctx });
          return { content: 'noted' };
        },
      });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'inspect ctx',
        model: 'test',
        systemPrompt: '',
        turnId: 'turn-ctx-99',
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.name).toBe('inspect');
      expect(seen[0]!.ctx).toEqual({
        sessionId: MAIN_SESSION_ID,
        turnId: 'turn-ctx-99',
        callId: 'tool_ctx_42',
        subagentDepth: 0,
        signal: expect.any(AbortSignal),
      });
    });

    it('respects maxLlmCalls limit', async () => {
      // The LLM returns tool_use on every call.
      const infiniteToolResponses = Array.from({ length: 20 }, () => [
        { type: 'message_start' as const },
        { type: 'tool_use' as const, id: 'tool_01', name: 'loop_tool', input: {} },
        { type: 'message_end' as const, stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
      ]);

      const llmClient = createMockLLMClient(infiniteToolResponses);

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'result' }),
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Loop',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        maxLlmCalls: 3,
      });

      // maxLlmCalls=3 limits this run to three LLM calls.
      expect(result.toolRounds).toBe(3);
      expect(result.stopReason).toBe('max_llm_calls');
      expect(result.text).toBe('');
    });

    it('returns error when no toolExecutor and LLM requests tool', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Sorry, I cannot search.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 } },
        ],
      ]);

      const runner = new AgentRunner({ llmClient, sessionManager });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Search something',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      expect(result.text).toBe('Sorry, I cannot search.');
      expect(result.toolRounds).toBe(1);
    });

    it('handles tool execution error gracefully', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'failing_tool', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'The tool failed.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 } },
        ],
      ]);

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => { throw new Error('Connection timeout'); },
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Try tool',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      expect(result.text).toBe('The tool failed.');
    });

    it('CH-13 returns Provider error stopReason with reported usage after one call', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Error occurred' },
          { type: 'message_end', stopReason: 'error', usage: { inputTokens: 5, outputTokens: 3 } },
        ],
      ]);
      const chatStream = vi.spyOn(llmClient, 'chatStream');

      const runner = new AgentRunner({ llmClient, sessionManager });
      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      expect(result.stopReason).toBe('error');
      expect(result.text).toBe('Error occurred');
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
      expect(chatStream).toHaveBeenCalledTimes(1);
    });

    it('injects steering messages between tool iterations', async () => {
      const capturedCalls: ModelInvocationRequest['messages'][] = [];
      let callIndex = 0;
      let injected = false;

      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          capturedCalls.push(params.messages.map((m) => ({ ...m })));

          if (callIndex === 0) {
            callIndex++;
            yield { type: 'message_start' } as ModelStreamEvent;
            yield {
              type: 'tool_call',
              call: {
                callId: 'tool_01',
                name: 'search',
                input: { state: 'ready', value: {} },
              },
            } as ModelStreamEvent;
            yield {
              type: 'message_end',
              stopReason: 'tool_use',
              usage: { inputTokens: 10, outputTokens: 5 },
            } as ModelStreamEvent;
            return;
          }

          yield { type: 'message_start' } as ModelStreamEvent;
          yield { type: 'text_delta', text: 'done' } as ModelStreamEvent;
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 12, outputTokens: 6 },
          } as ModelStreamEvent;
        },
        async chat() {
          throw new Error('Not used');
        },
      };

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'ok' }),
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'start',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        getSteeringMessages: () => {
          if (injected) return [];
          injected = true;
          return [{ role: 'user', content: 'interrupt now' }];
        },
      });

      expect(result.text).toBe('done');
      expect(capturedCalls).toHaveLength(2);
      expect(capturedCalls[1]!.some((m) => m.role === 'user' && m.content === 'interrupt now')).toBe(true);
    });
  });

  // ── Event callbacks ─────────────────────────────────

  describe('events', () => {
    it('CH-02 correlates run_start with the origin message and run_end', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Hi' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => events.push(e),
      });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        originMessageId: 'message-1',
      });

      expect(events[0]).toMatchObject({
        type: 'run_start',
        sessionId: MAIN_SESSION_ID,
        turnId: 'test-turn',
        originMessageId: 'message-1',
      });
      expect(events[events.length - 1]).toMatchObject({
        type: 'run_end',
        sessionId: MAIN_SESSION_ID,
        turnId: 'test-turn',
      });
    });

    it('emits text_delta events for streaming', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Hello' },
          { type: 'text_delta', text: ' world' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 4 } },
        ],
      ]);

      const textDeltas: string[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => { if (e.type === 'text_delta') textDeltas.push(e.text); },
      });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Hi', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(textDeltas).toEqual(['Hello', ' world']);
    });

    it('emits tool_use and tool_result events', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: { q: 'test' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Found it.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'search result' }),
        onEvent: (e) => events.push(e),
      });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      const toolUseEvent = events.find((e) => e.type === 'tool_use');
      const toolResultEvent = events.find((e) => e.type === 'tool_result');
      expect(toolUseEvent).toBeDefined();
      expect(toolResultEvent).toBeDefined();
      if (toolResultEvent?.type === 'tool_result') {
        expect(toolResultEvent.result.content).toBe('search result');
      }
    });

    it('emits llm_call with round number', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'tool', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const llmCalls: number[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'ok' }),
        onEvent: (e) => { if (e.type === 'llm_call') llmCalls.push(e.round); },
      });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Go', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(llmCalls).toEqual([0, 1]);
    });

    it('preserves the parent run\'s emit context when a tool re-enters run() (nested subagent regression)', async () => {
      // Simulates the subagent path: the parent's toolExecutor invokes
      // runner.run(...) for a CHILD turn with a different sessionId/turnId,
      // then control returns to the parent. If currentParams were reset to
      // null after the nested call, the parent's subsequent emit() events
      // (tool_result, second llm_call, run_end) would all be dropped.
      const llmClient = createMockLLMClient([
        // Parent round 1: emit tool_use.
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tu-1', name: 'nested', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        // Child run (triggered from inside toolExecutor).
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'child' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
        // Parent round 2 (after tool result).
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'parent-final' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 7 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => events.push(e),
        toolExecutor: async () => {
          // Re-enter run() with a different sessionId, mirroring Child execution.
          await createEmptyTestSession(sessionManager, CHILD_SESSION_ID).catch(() => undefined);
          await runner.run({
            sessionId: CHILD_SESSION_ID,
            message: 'child-msg',
            model: 'test',
            systemPrompt: '',
            turnId: 'child-turn',
          });
          return { content: 'tool-output' };
        },
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Parent kicks off',
        model: 'test',
        systemPrompt: '',
        turnId: 'parent-turn',
      });

      // Parent-only assertions: post-nested events must reach onEvent with
      // the parent's sessionId/turnId.
      expect(result.text).toBe('parent-final');
      const parentEvents = events.filter((e) => e.sessionId === MAIN_SESSION_ID);
      const parentTypes = parentEvents.map((e) => e.type);
      expect(parentTypes).toContain('tool_result');
      expect(parentTypes.filter((t) => t === 'llm_call').length).toBe(2);
      expect(parentTypes).toContain('run_end');
      // Confirm tagging: every parent event carries the parent's turnId.
      for (const e of parentEvents) {
        if (e.type === 'user_message') continue;
        expect(e.turnId).toBe('parent-turn');
      }
    });

    // These regression tests pin down the Current Runner invariant:
    // turnCtx is sourced from the
    // current run()'s call frame, not any instance state — so neither
    // sequential runs nor concurrent runs can pollute each other's events.

    it('tags emits with the active run\'s turnCtx — sequential runs do not leak ctx into each other', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'A' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'B' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => events.push(e),
      });

      await runner.run({
        sessionId: MAIN_SESSION_ID, message: 'first', model: 'test', systemPrompt: '', turnId: 'turn-A',
      });
      await createEmptyTestSession(sessionManager, OTHER_SESSION_ID);
      await runner.run({
        sessionId: OTHER_SESSION_ID, message: 'second', model: 'test', systemPrompt: '', turnId: 'turn-B',
      });

      const aEvents = events.filter((e) => e.sessionId === MAIN_SESSION_ID);
      const bEvents = events.filter((e) => e.sessionId === OTHER_SESSION_ID);
      expect(aEvents.length).toBeGreaterThan(0);
      expect(bEvents.length).toBeGreaterThan(0);
      for (const e of aEvents) {
        if (e.type === 'user_message') continue;
        expect(e.turnId).toBe('turn-A');
      }
      for (const e of bEvents) {
        if (e.type === 'user_message') continue;
        expect(e.turnId).toBe('turn-B');
      }
    });

    it('concurrent runs on the same AgentRunner instance do not interleave each other\'s turnCtx', async () => {
      // Two independent runs in flight on the SAME runner instance. The mock
      // LLM yields control between message_start and text_delta via a real
      // await, forcing the two runs to interleave inside the same event loop.
      let resolveLatch!: () => void;
      const latch = new Promise<void>((r) => { resolveLatch = r; });

      const llmClient: ModelInvocationPort = {
        chatStream: (() => {
          let call = 0;
          return async function* () {
            const which = call++;
            yield { type: 'message_start' } as ModelStreamEvent;
            if (which === 0) {
              // First run: park here until the second run has also started.
              await latch;
            } else {
              // Second run: release the first.
              resolveLatch();
            }
            yield { type: 'text_delta', text: which === 0 ? 'A' : 'B' } as ModelStreamEvent;
            yield {
              type: 'message_end',
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1 },
            } as ModelStreamEvent;
          };
        })(),
        async chat(): Promise<ModelInvocationResponse> { throw new Error('Not used in this test'); },
      };

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => events.push(e),
      });
      await createEmptyTestSession(sessionManager, CONCURRENT_SESSION_ID);

      await Promise.all([
        runner.run({
          sessionId: MAIN_SESSION_ID, message: 'p-A', model: 'test', systemPrompt: '', turnId: 'turn-A',
        }),
        runner.run({
          sessionId: CONCURRENT_SESSION_ID, message: 'p-B', model: 'test', systemPrompt: '', turnId: 'turn-B',
        }),
      ]);

      // Every event must carry the (sessionId, turnId) pair of the run that
      // produced it. If the pre-refactor instance-state design were in place,
      // run A's text_delta (emitted AFTER B set currentParams) would carry
      // run B's tag.
      const a = events.filter((e) => e.sessionId === MAIN_SESSION_ID);
      const b = events.filter((e) => e.sessionId === CONCURRENT_SESSION_ID);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      for (const e of a) {
        if (e.type === 'user_message') continue;
        expect(e.turnId).toBe('turn-A');
      }
      for (const e of b) {
        if (e.type === 'user_message') continue;
        expect(e.turnId).toBe('turn-B');
      }
    });
  });

  // ── Session persistence ─────────────────────────────

  describe('session persistence', () => {
    it('saves user and assistant messages', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Reply' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
        ],
      ]);

      const runner = new AgentRunner({ llmClient, sessionManager });
      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Hello', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      const messages = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.message.role).toBe('user');
      expect(messages[0]!.message.content).toBe('Hello');
      expect(messages[1]!.message.role).toBe('assistant');
    });

    it('saves toolResult messages with correct role', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'result' }),
      });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      const messages = sessionManager.getMessages(MAIN_SESSION_ID);
      // user(Search) → assistant(tool_use) → toolResult → assistant(Done)
      expect(messages).toHaveLength(4);
      expect(messages[0]!.message.role).toBe('user');
      expect(messages[1]!.message.role).toBe('assistant');
      expect(messages[2]!.message.role).toBe('toolResult');
      expect(messages[3]!.message.role).toBe('assistant');
    });

    it.each([
      {
        label: 'unknown tool',
        toolName: 'missing',
        executor: async (toolName) => ({
          content: `Tool "${toolName}" not found`,
          isError: true,
        }),
        expectedError: 'not found',
      },
      {
        label: 'executor-reported invalid input',
        toolName: 'validate',
        executor: async () => ({ content: 'Invalid input: value is required', isError: true }),
        expectedError: 'Invalid input',
      },
      {
        label: 'executor throw',
        toolName: 'explode',
        executor: async () => { throw new Error('executor boom'); },
        expectedError: 'executor boom',
      },
    ] satisfies Array<{
      label: string;
      toolName: string;
      executor: ToolExecutor;
      expectedError: string;
    }>)('CH-03 persists a paired error tool result for $label', async ({ toolName, executor, expectedError }) => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool-error', name: toolName, input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Handled.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);
      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: executor,
        onEvent: (event) => events.push(event),
      });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Use a tool',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      const messages = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(messages.map(({ message }) => message.role)).toEqual([
        'user',
        'assistant',
        'toolResult',
        'assistant',
      ]);
      const assistantBlocks = messages[1]!.message.content as ChatContentBlock[];
      expect(assistantBlocks).toContainEqual(
        expect.objectContaining({ type: 'tool_use', id: 'tool-error', name: toolName }),
      );
      const resultBlocks = messages[2]!.message.content as ChatContentBlock[];
      expect(resultBlocks).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tool-error',
          content: expect.stringContaining(expectedError),
        }),
      ]);
      const resultEvent = events.find((event) => event.type === 'tool_result');
      expect(resultEvent?.type === 'tool_result' && resultEvent.result.isError).toBe(true);
    });
  });

  // ── Error handling ──────────────────────────────────

  describe('error handling', () => {
    it('CH-13 emits error event and throws after one Provider stream call', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'error', error: new Error('API error') },
        ],
      ]);
      const chatStream = vi.spyOn(llmClient, 'chatStream');

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => events.push(e),
      });

      await expect(
        runner.run({ sessionId: MAIN_SESSION_ID, message: 'Hi', model: 'test', systemPrompt: '', turnId: 'test-turn' }),
      ).rejects.toThrow('API error');

      expect(events.some((e) => e.type === 'error')).toBe(true);
      expect(chatStream).toHaveBeenCalledTimes(1);
    });

    it('carries accumulated usage when execution fails after a successful call', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 11, outputTokens: 7 } },
        ],
        [
          { type: 'message_start' },
          { type: 'error', error: new Error('second call failed') },
        ],
      ]);
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: vi.fn(async () => ({ content: 'result' })),
      });

      const failure = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AgentExecutionFailure);
      expect(failure).toEqual(expect.objectContaining({
        kind: 'agent_execution_failure',
        message: 'second call failed',
        usage: { inputTokens: 11, outputTokens: 7 },
      }));
    });
  });

  // ── Hook on() API ───────────────────────────────────────

  describe('hooks', () => {
    it('CH-04 awaits before_tool_call before executing the Tool', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);
      const hookEntered = createDeferred();
      const releaseHook = createDeferred();
      const hookCompleted = createDeferred();
      const toolExecutor = vi.fn(async () => ({ content: 'result' }));
      const runner = new AgentRunner({ llmClient, sessionManager, toolExecutor });
      runner.on('before_tool_call', async () => {
        hookEntered.resolve();
        await releaseHook.promise;
        hookCompleted.resolve();
        return { action: 'allow' };
      });

      const runPromise = runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Search',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      await hookEntered.promise;
      try {
        expect(toolExecutor).not.toHaveBeenCalled();
      } finally {
        releaseHook.resolve();
      }
      await runPromise;
      await hookCompleted.promise;
      expect(toolExecutor).toHaveBeenCalledTimes(1);
    });

    it('before_tool_call allow passes through', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: { q: 'test' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const executedTools: string[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async (name) => { executedTools.push(name); return { content: 'ok' }; },
      });
      const controller = new AbortController();
      let hookSignal: AbortSignal | undefined;
      runner.on('before_tool_call', async ({ signal }) => {
        hookSignal = signal;
        return { action: 'allow' };
      });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Search',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        signal: controller.signal,
      });

      expect(executedTools).toEqual(['search']);
      expect(hookSignal).toBe(controller.signal);
    });

    it('CH-03 persists a paired error tool result when before_tool_call denies execution', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'exec', input: { cmd: 'rm -rf /' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Tool was blocked.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const executedTools: string[] = [];
      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async (name) => { executedTools.push(name); return { content: 'ok' }; },
        onEvent: (e) => events.push(e),
      });
      runner.on('before_tool_call', async () => ({ action: 'deny', reason: 'dangerous command' }));

      const result = await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Run it', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(executedTools).toHaveLength(0);
      expect(result.text).toBe('Tool was blocked.');
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult?.type === 'tool_result' && toolResult.result.isError).toBe(true);
      const messages = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(messages.map(({ message }) => message.role)).toEqual([
        'user',
        'assistant',
        'toolResult',
        'assistant',
      ]);
      const assistantBlocks = messages[1]!.message.content as ChatContentBlock[];
      expect(assistantBlocks).toContainEqual(
        expect.objectContaining({ type: 'tool_use', id: 'tool_01', name: 'exec' }),
      );
      expect(messages[2]!.message.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tool_01',
          content: 'Tool blocked: dangerous command',
        },
      ]);
    });

    it('before_tool_call modifies input', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: { q: 'original' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const capturedInputs: Record<string, unknown>[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async (_, input) => { capturedInputs.push(input); return { content: 'ok' }; },
      });
      runner.on('before_tool_call', async ({ input }) => ({
        action: 'allow',
        input: { ...input, q: 'modified' },
      }));

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(capturedInputs[0]?.q).toBe('modified');
    });

    it('awaits after_tool_call settlement before continuing the Turn', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const hookEntered = createDeferred();
      const releaseHook = createDeferred();
      const hookCompleted = createDeferred();
      const afterPayloads: { toolName: string; durationMs?: number }[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'result' }),
      });
      runner.on('after_tool_call', async ({ toolName, durationMs }) => {
        afterPayloads.push({ toolName, durationMs });
        hookEntered.resolve();
        await releaseHook.promise;
        hookCompleted.resolve();
      });

      const runPromise = runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Search',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      await hookEntered.promise;
      releaseHook.resolve();
      const result = await runPromise;
      await hookCompleted.promise;

      expect(result.stopReason).toBe('end_turn');
      expect(afterPayloads).toHaveLength(1);
      expect(afterPayloads[0]?.toolName).toBe('search');
      expect(afterPayloads[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('awaits bounded compaction observers before summary and after commit', async () => {
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'user', content: 'A'.repeat(800) });
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'assistant', content: 'B'.repeat(800) });
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'user', content: 'recent question' });
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'assistant', content: 'recent answer' });

      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Condensed summary.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done after compaction.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const beforeHookEntered = createDeferred();
      const releaseBeforeHook = createDeferred();
      const beforeHookCompleted = createDeferred();
      const afterHookEntered = createDeferred();
      const releaseAfterHook = createDeferred();
      const afterHookCompleted = createDeferred();
      const beforePayloads: Array<{ trigger: string; estimatedTokens: number }> = [];
      const afterPayloads: Array<{ trigger: string; tokensBefore: number; tokensAfter: number; droppedMessages: number }> = [];
      const runner = new AgentRunner({ llmClient, sessionManager });
      runner.on('before_compaction', async ({ trigger, estimatedTokens }) => {
        beforePayloads.push({ trigger, estimatedTokens });
        beforeHookEntered.resolve();
        await releaseBeforeHook.promise;
        beforeHookCompleted.resolve();
      });
      runner.on('after_compaction', async ({ trigger, tokensBefore, tokensAfter, droppedMessages }) => {
        afterPayloads.push({ trigger, tokensBefore, tokensAfter, droppedMessages });
        afterHookEntered.resolve();
        await releaseAfterHook.promise;
        afterHookCompleted.resolve();
      });

      const runPromise = runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Continue',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        contextWindowTokens: 120,
        compaction: {
          enabled: true,
          reserveTokens: 0,
          keepRecentTurns: 1,
          toolResultContextShare: 0.5,
          toolResultHeadChars: 100,
          toolResultTailChars: 100,
          timeoutSeconds: 30,
        },
      });

      await beforeHookEntered.promise;
      releaseBeforeHook.resolve();
      await beforeHookCompleted.promise;
      await afterHookEntered.promise;
      releaseAfterHook.resolve();
      const result = await runPromise;
      await Promise.all([beforeHookCompleted.promise, afterHookCompleted.promise]);

      expect(result.compacted).toBe(true);
      expect(beforePayloads).toHaveLength(1);
      expect(beforePayloads[0]?.trigger).toBe('preemptive');
      expect(beforePayloads[0]?.estimatedTokens).toBeGreaterThan(120);
      expect(afterPayloads).toHaveLength(1);
      expect(afterPayloads[0]?.trigger).toBe('preemptive');
      expect(afterPayloads[0]?.tokensBefore).toBeGreaterThan(afterPayloads[0]?.tokensAfter ?? 0);
      // The current user message is appended only after preflight. Preemptive
      // compaction therefore sees four seeded messages, keeps the latest Turn,
      // and drops the first two without including the current prompt.
      expect(afterPayloads[0]?.droppedMessages).toBe(2);
    });

    it('CH-11 uses persisted compaction history on the next turn', async () => {
      const persistedImageData = 'AAAA'.repeat(500);
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'user',
        content: [
          { type: 'text', text: `OLD_QUESTION_${'A'.repeat(800)}` },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: persistedImageData },
            dimensions: { width: 200, height: 200 },
          },
        ],
      });
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'assistant',
        content: `OLD_ANSWER_${'B'.repeat(800)}`,
      });
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'user', content: 'recent question' });
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'assistant', content: 'recent answer' });

      const compactingDelegate = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Persisted summary.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'First result.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } },
        ],
      ]);
      const compactionRequests: ModelInvocationRequest[] = [];
      const compactingClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          compactionRequests.push(params);
          yield* compactingDelegate.chatStream(params);
        },
        chat: compactingDelegate.chat,
      };
      const compactingRunner = new AgentRunner({
        llmClient: compactingClient,
        sessionManager,
      });

      const firstResult = await compactingRunner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'first current question',
        model: 'test',
        systemPrompt: '',
        turnId: 'first-turn',
        contextWindowTokens: 120,
        compaction: {
          enabled: true,
          reserveTokens: 0,
          keepRecentTurns: 1,
          toolResultContextShare: 0.5,
          toolResultHeadChars: 100,
          toolResultTailChars: 100,
          timeoutSeconds: 30,
        },
      });
      expect(firstResult.compacted).toBe(true);
      const summaryRequest = JSON.stringify(compactionRequests[0]?.messages);
      expect(summaryRequest).toContain('[Image]: media_type=image/png, ~64 tokens');
      expect(summaryRequest).not.toContain(persistedImageData);

      let nextTurnMessages: ModelInvocationRequest['messages'] = [];
      const reloadedSessionManager = new SessionManager(agentHome);
      expect(JSON.stringify(reloadedSessionManager.getMessages(MAIN_SESSION_ID))).toContain(persistedImageData);
      const nextTurnClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          nextTurnMessages = params.messages.map((message) => ({ ...message }));
          yield { type: 'message_start' } as ModelStreamEvent;
          yield { type: 'text_delta', text: 'Second result.' } as ModelStreamEvent;
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 8, outputTokens: 3 },
          } as ModelStreamEvent;
        },
        async chat() {
          throw new Error('Not used');
        },
      };
      const nextRunner = new AgentRunner({
        llmClient: nextTurnClient,
        sessionManager: reloadedSessionManager,
      });

      await nextRunner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'second current question',
        model: 'test',
        systemPrompt: '',
        turnId: 'second-turn',
        compaction: {
          enabled: false,
          reserveTokens: 0,
          keepRecentTurns: 1,
          toolResultContextShare: 0.5,
          toolResultHeadChars: 100,
          toolResultTailChars: 100,
          timeoutSeconds: 30,
        },
      });

      const contents = nextTurnMessages.map((message) => message.content);
      const serializedNextTurn = JSON.stringify(nextTurnMessages);
      expect(String(contents[0])).toContain('Persisted summary.');
      expect(serializedNextTurn).not.toContain('OLD_QUESTION_');
      expect(serializedNextTurn).not.toContain('OLD_ANSWER_');
      expect(serializedNextTurn).not.toContain(persistedImageData);
      expect(contents).toContain('recent question');
      expect(contents).toContain('recent answer');
      expect(contents).toContain('first current question');
      expect(nextTurnMessages.some(
        (message) => message.role === 'assistant' &&
          JSON.stringify(message.content).includes('First result.'),
      )).toBe(true);
      expect(contents.filter((content) => content === 'second current question')).toHaveLength(1);
    });

    it('priority: higher priority hook runs first', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'search', input: { q: 'original' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Done.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 5 } },
        ],
      ]);

      const order: number[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'ok' }),
      });
      runner
        .on('before_tool_call', async () => { order.push(1); return { action: 'allow' }; }, { priority: 1 })
        .on('before_tool_call', async () => { order.push(10); return { action: 'allow' }; }, { priority: 10 });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'Go', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(order).toEqual([10, 1]);
    });
  });

  // ── sanitizeSessionTail / trailing user cleanup ──────

  describe('sanitizeSessionTail', () => {
    it('user 消息已下沉到 runAttempt: run() 不再于入口立即 append', async () => {
      // Force an LLM error after runAttempt persists the user following preflight.
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'error', error: new Error('boom') },
        ],
      ]);

      const runner = new AgentRunner({ llmClient, sessionManager });
      await expect(
        runner.run({ sessionId: MAIN_SESSION_ID, message: 'Hello', model: 'test', systemPrompt: '', turnId: 'test-turn' }),
      ).rejects.toThrow('boom');

      // The user remains persisted when the LLM fails after preflight.
      const messages = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0]!.message.role).toBe('user');
      expect(messages[0]!.message.content).toBe('Hello');
    });

    it('启动时若末尾存在孤立 trailing user, runAttempt 入口将其从内存视图剥离', async () => {
      // Seed an orphan user message left by a failed previous Turn.
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'user', content: 'orphan' });
      const beforeCount = sessionManager.getMessages(MAIN_SESSION_ID).length;
      expect(beforeCount).toBe(1);

      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);

      let capturedMessages: ModelInvocationRequest['messages'] = [];
      const sniffer: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          capturedMessages = params.messages.map(m => ({ ...m }));
          yield* llmClient.chatStream(params);
        },
        async chat() { throw new Error('Not used'); },
      };

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient: sniffer,
        sessionManager,
        onEvent: (e) => events.push(e),
      });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'real', model: 'test', systemPrompt: '', turnId: 't1' });

      // Provider input contains the real message, not the orphan.
      const userMsgs = capturedMessages.filter(m => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]!.content).toBe('real');

      // The active Session branch contains user(real) and assistant only.
      const afterMessages = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(afterMessages).toHaveLength(2);
      expect(afterMessages[0]!.message.content).toBe('real');
      expect(afterMessages[1]!.message.role).toBe('assistant');

      // A session_tail_sanitized event is emitted.
      const sanitized = events.find(e => e.type === 'session_tail_sanitized');
      expect(sanitized).toBeDefined();
      expect((sanitized as { discardedRole: string }).discardedRole).toBe('user');
    });

    it('空 session: sanitize 不报错也不 emit', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);
      const events: AgentEvent[] = [];
      const runner = new AgentRunner({ llmClient, sessionManager, onEvent: (e) => events.push(e) });

      await runner.run({ sessionId: MAIN_SESSION_ID, message: 'first', model: 'test', systemPrompt: '', turnId: 't1' });

      expect(events.find(e => e.type === 'session_tail_sanitized')).toBeUndefined();
    });

    it('末尾为 assistant 时不触发清洗', async () => {
      // Complete one normal Turn ending with an assistant message.
      const llmClient1 = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'reply1' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);
      const runner1 = new AgentRunner({ llmClient: llmClient1, sessionManager });
      await runner1.run({ sessionId: MAIN_SESSION_ID, message: 'q1', model: 'test', systemPrompt: '', turnId: 't1' });
      const tail = sessionManager.getMessages(MAIN_SESSION_ID).slice(-1)[0];
      expect(tail!.message.role).toBe('assistant');

      // Sanitization is a no-op on the second Turn.
      const events: AgentEvent[] = [];
      const llmClient2 = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'reply2' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);
      const runner2 = new AgentRunner({ llmClient: llmClient2, sessionManager, onEvent: (e) => events.push(e) });
      await runner2.run({ sessionId: MAIN_SESSION_ID, message: 'q2', model: 'test', systemPrompt: '', turnId: 't2' });

      expect(events.find(e => e.type === 'session_tail_sanitized')).toBeUndefined();

      // Full sequence: user(q1), assistant(reply1), user(q2), assistant(reply2).
      const all = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(all).toHaveLength(4);
      expect(all.map(r => r.message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('旧 session 中的空 aborted assistant 不进入 Provider history', async () => {
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'user', content: 'old request' });
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'assistant',
        content: [],
        abortMeta: { partial: true, stopReason: 'aborted' },
      });
      await sessionManager.appendMessage(MAIN_SESSION_ID, { role: 'user', content: 'later request' });
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'assistant',
        content: [{ type: 'text', text: 'later reply' }],
      });

      let capturedMessages: ModelInvocationRequest['messages'] = [];
      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          capturedMessages = params.messages.map((message) => ({ ...message }));
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'current reply' };
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 5, outputTokens: 2 },
          };
        },
        async chat() { throw new Error('Not used'); },
      };
      const runner = new AgentRunner({ llmClient, sessionManager });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'current request',
        model: 'test',
        systemPrompt: '',
        turnId: 't-legacy-empty-abort',
      });

      expect(capturedMessages).not.toContainEqual({ role: 'assistant', content: [] });
      expect(capturedMessages).toEqual([
        { role: 'user', content: 'old request' },
        { role: 'user', content: 'later request' },
        { role: 'assistant', content: [{ type: 'text', text: 'later reply' }] },
        { role: 'user', content: 'current request' },
      ]);
      expect(sessionManager.getMessages(MAIN_SESSION_ID)).toContainEqual(
        expect.objectContaining({
          message: {
            role: 'assistant',
            content: [],
            abortMeta: { partial: true, stopReason: 'aborted' },
          },
        }),
      );
    });
  });

  // ── Abort（core-abort-spec.md §7） ──────────────────

  describe('abort', () => {
    // Abort before run starts returns immediately.
    it('abort before run starts → 立即返回 aborted，无 LLM 调用', async () => {
      const controller = new AbortController();
      controller.abort();

      let llmCalled = false;
      const llmClient: ModelInvocationPort = {
        async *chatStream() {
          llmCalled = true;
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
        },
        async chat() { throw new Error('Not used'); },
      };

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({ llmClient, sessionManager, onEvent: (e) => events.push(e) });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-early-abort',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.toolRounds).toBe(0);
      expect(llmCalled).toBe(false);
      // The run_start and run_end event pair remains complete.
      expect(events.find(e => e.type === 'run_start')).toBeDefined();
      expect(events.find(e => e.type === 'run_end')).toBeDefined();
    });

    // Abort during streaming persists a partial assistant with abort metadata.
    it('abort during LLM stream → stopReason=aborted, partial assistant 带 abortMeta 写入', async () => {
      const controller = new AbortController();

      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'partial reply…' };
          // Trigger external abort, then simulate the SDK AbortError.
          controller.abort();
          if (params.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } };
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });
      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-stream-abort',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      expect(result.text).toBe('partial reply…');

      // The final assistant record carries abort metadata.
      const records = sessionManager.getMessages(MAIN_SESSION_ID);
      const last = records[records.length - 1]!;
      expect(last.message.role).toBe('assistant');
      expect(last.message.abortMeta).toEqual({ partial: true, stopReason: 'aborted' });
    });

    it('abort before first model content → 不持久化空 assistant', async () => {
      const controller = new AbortController();
      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          yield { type: 'message_start' };
          controller.abort();
          if (params.signal?.aborted) {
            const error = new Error('aborted before content');
            error.name = 'AbortError';
            throw error;
          }
        },
        async chat() { throw new Error('Not used'); },
      };
      const runner = new AgentRunner({ llmClient, sessionManager });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-abort-before-content',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      expect(result.content).toEqual([]);
      expect(sessionManager.getMessages(MAIN_SESSION_ID).map(({ message }) => message.role))
        .toEqual(['user']);
    });

    // ③ abort during tool loop → current Turn closes every emitted Tool Call pair
    it('closes remaining Tool Calls as not_executed after abort between calls', async () => {
      const controller = new AbortController();

      // The LLM returns two tool_use blocks.
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tu-1', name: 'echo', input: { msg: 'a' } },
          { type: 'tool_use', id: 'tu-2', name: 'echo', input: { msg: 'b' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
        ],
      ]);

      let toolCallCount = 0;
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async (_name, input) => {
          toolCallCount++;
          // Abort after the first tool; the second must not start.
          if (toolCallCount === 1) {
            controller.abort();
          }
          return { content: `echoed ${(input as { msg: string }).msg}` };
        },
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'run tools',
        model: 'test',
        systemPrompt: '',
        turnId: 't-tool-loop-abort',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // The first tool completes and the second does not start.
      expect(toolCallCount).toBe(1);
      const records = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(records.map(({ message }) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
      const assistantBlocks = records[1]!.message.content as ChatContentBlock[];
      expect(assistantBlocks.filter((block) => block.type === 'tool_use').map((block) => block.id)).toEqual([
        'tu-1',
        'tu-2',
      ]);

      const repairEvents: AgentEvent[] = [];
      const recoveryRunner = new AgentRunner({
        llmClient: createMockLLMClient([[
          { type: 'message_start' },
          { type: 'text_delta', text: 'Recovered.' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ]]),
        sessionManager,
        onEvent: (event) => repairEvents.push(event),
      });
      await recoveryRunner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'continue',
        model: 'test',
        systemPrompt: '',
        turnId: 't-after-tool-loop-abort',
      });

      const recoveredRecords = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(recoveredRecords.map(({ message }) => message.role)).toEqual([
        'user',
        'assistant',
        'toolResult',
        'user',
        'assistant',
      ]);
      expect(recoveredRecords[2]!.message.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'echoed a',
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu-2',
          content: 'Tool "echo" was not executed because the Turn was aborted.',
        },
      ]);
      expect(repairEvents).not.toContainEqual(
        expect.objectContaining({ type: 'orphan_tool_results_repaired' }),
      );
    });

    // Orphan repair at Turn start with an abort source.
    it('orphan repair: abort 造孤儿 → 下一 turn 起点写 aborted 内容 + emit source:abort', async () => {
      // Seed an assistant tool_use with abort metadata from a previous Turn.
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'starting…' },
          { type: 'tool_use', id: 'orphan-1', name: 'echo', input: { msg: 'x' } },
        ],
        abortMeta: { partial: true, stopReason: 'aborted' },
      });

      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'continue' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({ llmClient, sessionManager, onEvent: (e) => events.push(e) });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'retry',
        model: 'test',
        systemPrompt: '',
        turnId: 't-repair-abort',
      });

      // repair emit
      const repairEvent = events.find(e => e.type === 'orphan_tool_results_repaired');
      expect(repairEvent).toBeDefined();
      expect((repairEvent as { count: number; source: string }).count).toBe(1);
      expect((repairEvent as { source: string }).source).toBe('abort');

      // session：assistant(with tool_use) → toolResult(synthetic aborted) → user(retry) → assistant(continue)
      const records = sessionManager.getMessages(MAIN_SESSION_ID);
      const toolResultRecord = records.find(r => r.message.role === 'toolResult');
      expect(toolResultRecord).toBeDefined();
      const trContent = toolResultRecord!.message.content as Array<{ type: string; tool_use_id: string; content: string }>;
      expect(trContent[0]!.tool_use_id).toBe('orphan-1');
      // Content stays neutral; source distinguishes abort from recovery.
      expect(trContent[0]!.content).toBe('[tool call interrupted; session recovered]');
    });

    // Orphan repair for a non-abort recovery source.
    it('orphan repair: 无 abortMeta 孤儿（模拟崩溃恢复）→ 写 recovered 内容 + emit source:recovered', async () => {
      // Seed an orphan assistant tool_use without abort metadata to mimic a crash.
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'crash-1', name: 'echo', input: { msg: 'y' } },
        ],
      });

      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({ llmClient, sessionManager, onEvent: (e) => events.push(e) });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-repair-recovered',
      });

      const repairEvent = events.find(e => e.type === 'orphan_tool_results_repaired');
      expect(repairEvent).toBeDefined();
      expect((repairEvent as { source: string }).source).toBe('recovered');

      const records = sessionManager.getMessages(MAIN_SESSION_ID);
      const toolResultRecord = records.find(r => r.message.role === 'toolResult');
      const trContent = toolResultRecord!.message.content as Array<{ tool_use_id: string; content: string }>;
      expect(trContent[0]!.content).toBe('[tool call interrupted; session recovered]');
    });

    // Orphan-repair no-op.
    it('orphan repair: 干净 session（无孤儿）→ 不写盘、不 emit', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);

      const events: AgentEvent[] = [];
      const appendSpy = vi.spyOn(sessionManager, 'appendMessage');

      const runner = new AgentRunner({ llmClient, sessionManager, onEvent: (e) => events.push(e) });
      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-no-orphan',
      });

      // No orphan_tool_results_repaired event is emitted.
      expect(events.find(e => e.type === 'orphan_tool_results_repaired')).toBeUndefined();
      // No toolResult is appended because no real tool_use exists.
      const toolResultCalls = appendSpy.mock.calls.filter(c => (c[1] as { role: string }).role === 'toolResult');
      expect(toolResultCalls).toHaveLength(0);
    });

    // Orphan-repair write failure does not crash the Turn.
    it('orphan repair: write 失败 → log warn，turn 继续启动（不 rethrow）', async () => {
      // Seed an orphan.
      await sessionManager.appendMessage(MAIN_SESSION_ID, {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x-1', name: 'echo', input: {} }],
      });

      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'still ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);

      // Fail appendMessage only for the repair toolResult.
      const originalAppend = sessionManager.appendMessage.bind(sessionManager);
      const appendSpy = vi.spyOn(sessionManager, 'appendMessage').mockImplementation(async (key, msg) => {
        if (msg.role === 'toolResult') {
          throw new Error('disk full');
        }
        return originalAppend(key, msg);
      });

      const runner = new AgentRunner({ llmClient, sessionManager });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-repair-fail',
      });

      // The Turn completes normally.
      expect(result.stopReason).toBe('end_turn');
      expect(result.text).toBe('still ok');
      appendSpy.mockRestore();
    });

    // Persisted-state recovery when writing a partial assistant fails.
    it('orphan repair: partial-assistant 写盘失败 → 磁盘无 assistant → 下轮 repair no-op', async () => {
      const controller = new AbortController();

      // Simulate a disk-full error while writing the assistant.
      const originalAppend = sessionManager.appendMessage.bind(sessionManager);
      const appendSpy = vi.spyOn(sessionManager, 'appendMessage').mockImplementation(async (key, msg) => {
        if (msg.role === 'assistant') {
          throw new Error('disk full');
        }
        return originalAppend(key, msg);
      });

      // First Turn aborts midstream and enters partial-assistant persistence.
      const llmClient1: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'partial' };
          controller.abort();
          if (params.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner1 = new AgentRunner({ llmClient: llmClient1, sessionManager });
      const result1 = await runner1.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-partial-fail',
        signal: controller.signal,
      });

      // The section 4 fallback preserves the never-throws abort result.
      expect(result1.stopReason).toBe('aborted');

      // Only the user is persisted, so there is no tool-use orphan.
      const recordsAfterAbort = sessionManager.getMessages(MAIN_SESSION_ID);
      expect(recordsAfterAbort.map(r => r.message.role)).toEqual(['user']);

      appendSpy.mockRestore();

      // Repair is a no-op at the start of the second Turn.
      const events: AgentEvent[] = [];
      const llmClient2 = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'retry' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const runner2 = new AgentRunner({ llmClient: llmClient2, sessionManager, onEvent: (e) => events.push(e) });
      await runner2.run({
        sessionId: MAIN_SESSION_ID,
        message: 'retry',
        model: 'test',
        systemPrompt: '',
        turnId: 't-partial-fail-retry',
      });

      expect(events.find(e => e.type === 'orphan_tool_results_repaired')).toBeUndefined();
    });

    // R2 cumulative usage.
    it('R2 usage 累计: abort 前跑过 3 轮 tool → 返回 usage 累计值，非 0/0', async () => {
      const controller = new AbortController();
      let round = 0;

      // Each chatStream call reports mock usage {100, 50}.
      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          round++;
          yield { type: 'message_start' };
          if (round < 4) {
            // The first three rounds request a tool and continue.
            yield {
              type: 'tool_call',
              call: {
                callId: `tu-${round}`,
                name: 'echo',
                input: { state: 'ready', value: {} },
              },
            };
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 50 } };
          } else {
            // The fourth round aborts in the partial-stream branch.
            yield { type: 'text_delta', text: 'partial' };
            controller.abort();
            if (params.signal?.aborted) {
              const err = new Error('aborted');
              err.name = 'AbortError';
              throw err;
            }
          }
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'ok' }),
      });

      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'go',
        model: 'test',
        systemPrompt: '',
        turnId: 't-usage-accum',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // Three tool rounds plus zero reported usage from the partial stream.
      expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 150 });
      expect(result.toolRounds).toBe(3);
    });

    // R8 partial tool_use integrity.
    it('R8 partial tool_use: stream 到 tool_use 之前 abort → assistant 内容不含残缺 tool_use', async () => {
      const controller = new AbortController();

      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'thinking…' };
          // Abort before AnthropicClient would yield a complete tool_use.
          controller.abort();
          if (params.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });
      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-r8',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // The assistant record contains text only and no tool_use.
      const records = sessionManager.getMessages(MAIN_SESSION_ID);
      const assistant = records.find(r => r.message.role === 'assistant')!;
      const content = assistant.message.content as Array<{ type: string }>;
      expect(content.every(b => b.type === 'text')).toBe(true);
      expect(content.some(b => b.type === 'tool_use')).toBe(false);
    });

    // R11 isAbortError fallback diagnostics.
    it('R11 fallback: NetworkError + signal.aborted → 走 abort 分支 + log.warn 命中', async () => {
      const controller = new AbortController();
      const agentLogger = (await import('../../platform/logger/index.js')).Logger.get('AgentRunner');
      const warnSpy = vi.spyOn(agentLogger, 'warn');

      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          yield { type: 'message_start' };
          controller.abort();
          // Simulate an SDK that reports NetworkError while the signal is aborted.
          if (params.signal?.aborted) {
            const err = new Error('network broken');
            err.name = 'NetworkError';
            throw err;
          }
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });
      const result = await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-r11',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // The warning includes errName='NetworkError'.
      const swallowedCall = warnSpy.mock.calls.find(
        c => c[0] === 'non-abort error swallowed by abort fallback',
      );
      expect(swallowedCall).toBeDefined();
      expect((swallowedCall![1] as { errName: string }).errName).toBe('NetworkError');
      warnSpy.mockRestore();
    });

    // A real AbortError does not trigger the fallback warning.
    it('R11 对照组: 真 AbortError 名字 → 不触发 fallback warn log', async () => {
      const controller = new AbortController();
      const agentLogger = (await import('../../platform/logger/index.js')).Logger.get('AgentRunner');
      const warnSpy = vi.spyOn(agentLogger, 'warn');

      const llmClient: ModelInvocationPort = {
        async *chatStream(params: ModelInvocationRequest) {
          yield { type: 'message_start' };
          controller.abort();
          if (params.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError'; // Matches the primary name predicate.
            throw err;
          }
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });
      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-r11-ctrl',
        signal: controller.signal,
      });

      const swallowedCall = warnSpy.mock.calls.find(
        c => c[0] === 'non-abort error swallowed by abort fallback',
      );
      expect(swallowedCall).toBeUndefined();
      warnSpy.mockRestore();
    });

    // Pending steering is logged when abort occurs before injection. The behavior
    // belongs here even though the specification lists it with RuntimeApp tests.
    it('pending steering log-only: pendingSteering 非空时命中 abort 触发 log.info', async () => {
      const controller = new AbortController();
      const agentLogger = (await import('../../platform/logger/index.js')).Logger.get('AgentRunner');
      const infoSpy = vi.spyOn(agentLogger, 'info');

      // First round requests a tool, drains three steering messages, then reaches
      // the next iteration with an aborted signal and discards them.
      let round = 0;
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tu-1', name: 'echo', input: {} },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 3 } },
        ],
      ]);

      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => {
          round++;
          // Abort after the tool so the next iteration hits the signal check.
          controller.abort();
          return { content: 'ok' };
        },
      });

      await runner.run({
        sessionId: MAIN_SESSION_ID,
        message: 'go',
        model: 'test',
        systemPrompt: '',
        turnId: 't-pending-steering',
        signal: controller.signal,
        // Return three steering messages so pendingSteering is non-empty.
        getSteeringMessages: async () => [
          { role: 'user', content: 's1' },
          { role: 'user', content: 's2' },
          { role: 'user', content: 's3' },
        ],
      });

      expect(round).toBe(1);
      const infoCall = infoSpy.mock.calls.find(
        (c) => c[0] === 'dropped pending steering on abort',
      );
      expect(infoCall).toBeDefined();
      expect((infoCall![1] as { count: number }).count).toBe(3);
      infoSpy.mockRestore();
    });
  });
});
