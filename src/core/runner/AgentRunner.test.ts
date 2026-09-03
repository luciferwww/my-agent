import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentRunner } from './AgentRunner.js';
import { SessionManager } from '../session/SessionManager.js';
import type { ChatContentBlock, LLMClient, ChatParams, ChatResponse, StreamEvent } from '../../adapters/llm/types.js';
import { createToolExecutor } from '../tools/executor.js';
import type { ToolExecutor } from '../tools/types.js';
import type { AgentEvent } from './types.js';

// ── Mock LLMClient ──────────────────────────────────────

function createMockLLMClient(responses: StreamEvent[][]): LLMClient {
  let callIndex = 0;
  return {
    async *chatStream(): AsyncIterable<StreamEvent> {
      const events = responses[callIndex++] ?? [];
      for (const event of events) {
        yield event;
      }
    },
    async chat(): Promise<ChatResponse> {
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

// ── 测试 ────────────────────────────────────────────────

describe('AgentRunner', () => {
  let workspaceDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runner-test-'));
    sessionManager = new SessionManager(workspaceDir);
    await sessionManager.createSession('main');
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  // ── 基本对话 ────────────────────────────────────────

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
        sessionKey: 'main',
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
      let capturedMessages: ChatParams['messages'] = [];

      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          capturedMessages = params.messages.map(m => ({ ...m }));
          yield { type: 'message_start' } as StreamEvent;
          yield { type: 'text_delta', text: 'Response' } as StreamEvent;
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } as StreamEvent;
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });

      // 第一轮
      await runner.run({ sessionKey: 'main', message: 'First', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      // 第二轮——应该能看到第一轮的历史
      await runner.run({ sessionKey: 'main', message: 'Second', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      // 第二轮的 messages 应包含第一轮的历史
      // user(First) + assistant([{type:'text',text:'Response'}]) + user(Second)
      expect(capturedMessages[0]!.content).toBe('First');
      expect(capturedMessages[capturedMessages.length - 1]!.content).toBe('Second');
      // 中间有 assistant 消息
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
        sessionKey: 'main',
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
        // 第一轮：LLM 请求工具
        [
          { type: 'message_start' },
          { type: 'tool_use', id: 'tool_01', name: 'get_weather', input: { city: 'Tokyo' } },
          { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 10 } },
        ],
        // 第二轮：LLM 收到工具结果后回复
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
        sessionKey: 'main',
        message: 'Weather?',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        tools: [{ name: 'get_weather', description: 'Get weather', input_schema: {} }],
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
        sessionKey: 'main',
        message: 'Do tasks',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      expect(result.text).toBe('Done.');
      expect(result.toolRounds).toBe(2);
    });

    it('passes ToolContext (sessionKey/turnId/toolUseId) to toolExecutor', async () => {
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
        sessionKey: 'main',
        message: 'inspect ctx',
        model: 'test',
        systemPrompt: '',
        turnId: 'turn-ctx-99',
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.name).toBe('inspect');
      expect(seen[0]!.ctx).toEqual({
        sessionKey: 'main',
        turnId: 'turn-ctx-99',
        toolUseId: 'tool_ctx_42',
        signal: undefined,
      });
    });

    it('respects maxLlmCalls limit', async () => {
      // LLM 每次都返回 tool_use
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
        sessionKey: 'main',
        message: 'Loop',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        maxLlmCalls: 3,
      });

      // maxLlmCalls=3 意味着本次 run 最多只进行 3 次 LLM 调用。
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
        sessionKey: 'main',
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
        sessionKey: 'main',
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
        sessionKey: 'main',
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
      const capturedCalls: ChatParams['messages'][] = [];
      let callIndex = 0;
      let injected = false;

      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          capturedCalls.push(params.messages.map((m) => ({ ...m })));

          if (callIndex === 0) {
            callIndex++;
            yield { type: 'message_start' } as StreamEvent;
            yield { type: 'tool_use', id: 'tool_01', name: 'search', input: {} } as StreamEvent;
            yield {
              type: 'message_end',
              stopReason: 'tool_use',
              usage: { inputTokens: 10, outputTokens: 5 },
            } as StreamEvent;
            return;
          }

          yield { type: 'message_start' } as StreamEvent;
          yield { type: 'text_delta', text: 'done' } as StreamEvent;
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 12, outputTokens: 6 },
          } as StreamEvent;
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
        sessionKey: 'main',
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

  // ── 事件回调 ────────────────────────────────────────

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
        sessionKey: 'main',
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
        originMessageId: 'message-1',
      });

      expect(events[0]).toMatchObject({
        type: 'run_start',
        sessionKey: 'main',
        turnId: 'test-turn',
        originMessageId: 'message-1',
      });
      expect(events[events.length - 1]).toMatchObject({
        type: 'run_end',
        sessionKey: 'main',
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

      await runner.run({ sessionKey: 'main', message: 'Hi', model: 'test', systemPrompt: '', turnId: 'test-turn' });

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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

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

      await runner.run({ sessionKey: 'main', message: 'Go', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(llmCalls).toEqual([0, 1]);
    });

    it('preserves the parent run\'s emit context when a tool re-enters run() (nested subagent regression)', async () => {
      // Simulates the subagent path: the parent's toolExecutor invokes
      // runner.run(...) for a CHILD turn with a different sessionKey/turnId,
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
          // Re-enter run() with a different sessionKey, mirroring SubagentRunner.
          await sessionManager.createSession('child').catch(() => undefined);
          await runner.run({
            sessionKey: 'child',
            message: 'child-msg',
            model: 'test',
            systemPrompt: '',
            turnId: 'child-turn',
          });
          return { content: 'tool-output' };
        },
      });

      const result = await runner.run({
        sessionKey: 'main',
        message: 'Parent kicks off',
        model: 'test',
        systemPrompt: '',
        turnId: 'parent-turn',
      });

      // Parent-only assertions: post-nested events must reach onEvent with
      // the parent's sessionKey/turnId.
      expect(result.text).toBe('parent-final');
      const parentEvents = events.filter((e) => e.sessionKey === 'main');
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

    // Two follow-up regression tests added by the v2 emit-context refactor
    // (docs/architecture/core-runner-emit-context-refactor.md §4.3). They
    // pin down the post-refactor invariant: turnCtx is sourced from the
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
        sessionKey: 'main', message: 'first', model: 'test', systemPrompt: '', turnId: 'turn-A',
      });
      await sessionManager.createSession('other');
      await runner.run({
        sessionKey: 'other', message: 'second', model: 'test', systemPrompt: '', turnId: 'turn-B',
      });

      const aEvents = events.filter((e) => e.sessionKey === 'main');
      const bEvents = events.filter((e) => e.sessionKey === 'other');
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

      const llmClient: LLMClient = {
        chatStream: (() => {
          let call = 0;
          return async function* () {
            const which = call++;
            yield { type: 'message_start' } as StreamEvent;
            if (which === 0) {
              // First run: park here until the second run has also started.
              await latch;
            } else {
              // Second run: release the first.
              resolveLatch();
            }
            yield { type: 'text_delta', text: which === 0 ? 'A' : 'B' } as StreamEvent;
            yield {
              type: 'message_end',
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1 },
            } as StreamEvent;
          };
        })(),
        async chat(): Promise<ChatResponse> { throw new Error('Not used in this test'); },
      };

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        onEvent: (e) => events.push(e),
      });
      await sessionManager.createSession('concurrent-B');

      await Promise.all([
        runner.run({
          sessionKey: 'main', message: 'p-A', model: 'test', systemPrompt: '', turnId: 'turn-A',
        }),
        runner.run({
          sessionKey: 'concurrent-B', message: 'p-B', model: 'test', systemPrompt: '', turnId: 'turn-B',
        }),
      ]);

      // Every event must carry the (sessionKey, turnId) pair of the run that
      // produced it. If the pre-refactor instance-state design were in place,
      // run A's text_delta (emitted AFTER B set currentParams) would carry
      // run B's tag.
      const a = events.filter((e) => e.sessionKey === 'main');
      const b = events.filter((e) => e.sessionKey === 'concurrent-B');
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

  // ── Session 持久化 ─────────────────────────────────

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
      await runner.run({ sessionKey: 'main', message: 'Hello', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      const messages = sessionManager.getMessages('main');
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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      const messages = sessionManager.getMessages('main');
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
        executor: createToolExecutor([]),
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
        sessionKey: 'main',
        message: 'Use a tool',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      const messages = sessionManager.getMessages('main');
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

  // ── 错误处理 ────────────────────────────────────────

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
        runner.run({ sessionKey: 'main', message: 'Hi', model: 'test', systemPrompt: '', turnId: 'test-turn' }),
      ).rejects.toThrow('API error');

      expect(events.some((e) => e.type === 'error')).toBe(true);
      expect(chatStream).toHaveBeenCalledTimes(1);
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
        sessionKey: 'main',
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
        sessionKey: 'main',
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

      const result = await runner.run({ sessionKey: 'main', message: 'Run it', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(executedTools).toHaveLength(0);
      expect(result.text).toBe('Tool was blocked.');
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult?.type === 'tool_result' && toolResult.result.isError).toBe(true);
      const messages = sessionManager.getMessages('main');
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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(capturedInputs[0]?.q).toBe('modified');
    });

    it('CH-04 detaches after_tool_call from Turn settlement', async () => {
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
      const afterPayloads: { toolName: string; durationMs: number }[] = [];
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
        sessionKey: 'main',
        message: 'Search',
        model: 'test',
        systemPrompt: '',
        turnId: 'test-turn',
      });

      await hookEntered.promise;
      const result = await runPromise;
      releaseHook.resolve();
      await hookCompleted.promise;

      expect(result.stopReason).toBe('end_turn');
      expect(afterPayloads).toHaveLength(1);
      expect(afterPayloads[0]?.toolName).toBe('search');
      expect(afterPayloads[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('CH-04 detaches compaction observer Hooks from compaction and Turn settlement', async () => {
      await sessionManager.appendMessage('main', { role: 'user', content: 'A'.repeat(800) });
      await sessionManager.appendMessage('main', { role: 'assistant', content: 'B'.repeat(800) });
      await sessionManager.appendMessage('main', { role: 'user', content: 'recent question' });
      await sessionManager.appendMessage('main', { role: 'assistant', content: 'recent answer' });

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
        sessionKey: 'main',
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

      await Promise.all([beforeHookEntered.promise, afterHookEntered.promise]);
      const result = await runPromise;
      releaseBeforeHook.resolve();
      releaseAfterHook.resolve();
      await Promise.all([beforeHookCompleted.promise, afterHookCompleted.promise]);

      expect(result.compacted).toBe(true);
      expect(beforePayloads).toHaveLength(1);
      expect(beforePayloads[0]?.trigger).toBe('preemptive');
      expect(beforePayloads[0]?.estimatedTokens).toBeGreaterThan(120);
      expect(afterPayloads).toHaveLength(1);
      expect(afterPayloads[0]?.trigger).toBe('preemptive');
      expect(afterPayloads[0]?.tokensBefore).toBeGreaterThan(afterPayloads[0]?.tokensAfter ?? 0);
      // 当前 user 消息（'Continue'）下沉到 preflight 之后才 append，preemptive 压缩在
      // append 之前抛出，因此 compactHistory 看到的是 4 条预置消息（非 5 条），
      // keepRecentTurns:1 保留最近 1 个 user turn (recent question + recent answer = 2 条)，
      // 丢弃前 2 条。这是"压缩输入不被当前 user 污染"的预期表现。
      expect(afterPayloads[0]?.droppedMessages).toBe(2);
    });

    it('CH-11 uses persisted compaction history on the next turn', async () => {
      await sessionManager.appendMessage('main', {
        role: 'user',
        content: `OLD_QUESTION_${'A'.repeat(800)}`,
      });
      await sessionManager.appendMessage('main', {
        role: 'assistant',
        content: `OLD_ANSWER_${'B'.repeat(800)}`,
      });
      await sessionManager.appendMessage('main', { role: 'user', content: 'recent question' });
      await sessionManager.appendMessage('main', { role: 'assistant', content: 'recent answer' });

      const compactingClient = createMockLLMClient([
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
      const compactingRunner = new AgentRunner({
        llmClient: compactingClient,
        sessionManager,
      });

      const firstResult = await compactingRunner.run({
        sessionKey: 'main',
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

      let nextTurnMessages: ChatParams['messages'] = [];
      const reloadedSessionManager = new SessionManager(workspaceDir);
      const nextTurnClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          nextTurnMessages = params.messages.map((message) => ({ ...message }));
          yield { type: 'message_start' } as StreamEvent;
          yield { type: 'text_delta', text: 'Second result.' } as StreamEvent;
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 8, outputTokens: 3 },
          } as StreamEvent;
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
        sessionKey: 'main',
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
      expect(String(contents[0])).toContain('Persisted summary.');
      expect(contents.map(String).join('\n')).not.toContain('OLD_QUESTION_');
      expect(contents.map(String).join('\n')).not.toContain('OLD_ANSWER_');
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

      await runner.run({ sessionKey: 'main', message: 'Go', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(order).toEqual([10, 1]);
    });
  });

  // ── sanitizeSessionTail / trailing user 清洗 ──────────

  describe('sanitizeSessionTail', () => {
    it('user 消息已下沉到 runAttempt: run() 不再于入口立即 append', async () => {
      // 让 LLM 抛错，run() 会在 emit error 后抛出。
      // 关键断言：此时 session 中已有 user 消息（说明 runAttempt 在 preflight 通过后 append 了）。
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'error', error: new Error('boom') },
        ],
      ]);

      const runner = new AgentRunner({ llmClient, sessionManager });
      await expect(
        runner.run({ sessionKey: 'main', message: 'Hello', model: 'test', systemPrompt: '', turnId: 'test-turn' }),
      ).rejects.toThrow('boom');

      // runAttempt preflight 通过后会 append user，所以 LLM 报错时 user 已经在 session
      const messages = sessionManager.getMessages('main');
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0]!.message.role).toBe('user');
      expect(messages[0]!.message.content).toBe('Hello');
    });

    it('启动时若末尾存在孤立 trailing user, runAttempt 入口将其从内存视图剥离', async () => {
      // 手工伪造一条"上一轮失败遗留"的孤立 user 消息
      await sessionManager.appendMessage('main', { role: 'user', content: 'orphan' });
      const beforeCount = sessionManager.getMessages('main').length;
      expect(beforeCount).toBe(1);

      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'ok' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);

      let capturedMessages: ChatParams['messages'] = [];
      const sniffer: LLMClient = {
        async *chatStream(params: ChatParams) {
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

      await runner.run({ sessionKey: 'main', message: 'real', model: 'test', systemPrompt: '', turnId: 't1' });

      // sniffer 看到的 user content 应是 'real'，不含 'orphan'
      const userMsgs = capturedMessages.filter(m => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]!.content).toBe('real');

      // session 视图：orphan 已被 branch 剥离，新视图为 user(real) + assistant
      const afterMessages = sessionManager.getMessages('main');
      expect(afterMessages).toHaveLength(2);
      expect(afterMessages[0]!.message.content).toBe('real');
      expect(afterMessages[1]!.message.role).toBe('assistant');

      // emit 了 session_tail_sanitized 事件
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

      await runner.run({ sessionKey: 'main', message: 'first', model: 'test', systemPrompt: '', turnId: 't1' });

      expect(events.find(e => e.type === 'session_tail_sanitized')).toBeUndefined();
    });

    it('末尾为 assistant 时不触发清洗', async () => {
      // 先完成一轮正常对话，末尾是 assistant
      const llmClient1 = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'reply1' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);
      const runner1 = new AgentRunner({ llmClient: llmClient1, sessionManager });
      await runner1.run({ sessionKey: 'main', message: 'q1', model: 'test', systemPrompt: '', turnId: 't1' });
      const tail = sessionManager.getMessages('main').slice(-1)[0];
      expect(tail!.message.role).toBe('assistant');

      // 第二轮：sanitize 应是 no-op
      const events: AgentEvent[] = [];
      const llmClient2 = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'reply2' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
        ],
      ]);
      const runner2 = new AgentRunner({ llmClient: llmClient2, sessionManager, onEvent: (e) => events.push(e) });
      await runner2.run({ sessionKey: 'main', message: 'q2', model: 'test', systemPrompt: '', turnId: 't2' });

      expect(events.find(e => e.type === 'session_tail_sanitized')).toBeUndefined();

      // 完整序列: u(q1) → a(reply1) → u(q2) → a(reply2)
      const all = sessionManager.getMessages('main');
      expect(all).toHaveLength(4);
      expect(all.map(r => r.message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });
  });

  // ── Abort（core-abort-spec.md §7） ──────────────────

  describe('abort', () => {
    // ① abort before run starts → 立即返回
    it('abort before run starts → 立即返回 aborted，无 LLM 调用', async () => {
      const controller = new AbortController();
      controller.abort();

      let llmCalled = false;
      const llmClient: LLMClient = {
        async *chatStream() {
          llmCalled = true;
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
        },
        async chat() { throw new Error('Not used'); },
      };

      const events: AgentEvent[] = [];
      const runner = new AgentRunner({ llmClient, sessionManager, onEvent: (e) => events.push(e) });

      const result = await runner.run({
        sessionKey: 'main',
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
      // run_start + run_end 事件对完整
      expect(events.find(e => e.type === 'run_start')).toBeDefined();
      expect(events.find(e => e.type === 'run_end')).toBeDefined();
    });

    // ② abort during LLM stream → stopReason='aborted', partial assistant 写入（带 abortMeta）
    it('abort during LLM stream → stopReason=aborted, partial assistant 带 abortMeta 写入', async () => {
      const controller = new AbortController();

      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'partial reply…' };
          // 触发外部 abort，然后模拟 SDK 抛 AbortError
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
        sessionKey: 'main',
        message: 'Hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-stream-abort',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      expect(result.text).toBe('partial reply…');

      // session 里最后一条 assistant 应含 abortMeta
      const records = sessionManager.getMessages('main');
      const last = records[records.length - 1]!;
      expect(last.message.role).toBe('assistant');
      expect(last.message.abortMeta).toEqual({ partial: true, stopReason: 'aborted' });
    });

    // ③ abort during tool loop → 当前工具跑完，下一工具不启动
    it('CH-03 characterizes deferred orphan repair after abort between tool calls', async () => {
      const controller = new AbortController();

      // LLM 返回两个 tool_use 块
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
          // 第一个工具跑完后触发 abort，第二个工具不应启动
          if (toolCallCount === 1) {
            controller.abort();
          }
          return { content: `echoed ${(input as { msg: string }).msg}` };
        },
      });

      const result = await runner.run({
        sessionKey: 'main',
        message: 'run tools',
        model: 'test',
        systemPrompt: '',
        turnId: 't-tool-loop-abort',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // 第一个 tool 跑完，第二个不启动
      expect(toolCallCount).toBe(1);
      const records = sessionManager.getMessages('main');
      expect(records.map(({ message }) => message.role)).toEqual(['user', 'assistant']);
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
        sessionKey: 'main',
        message: 'continue',
        model: 'test',
        systemPrompt: '',
        turnId: 't-after-tool-loop-abort',
      });

      const repairedRecords = sessionManager.getMessages('main');
      expect(repairedRecords.map(({ message }) => message.role)).toEqual([
        'user',
        'assistant',
        'toolResult',
        'user',
        'assistant',
      ]);
      expect(repairedRecords[2]!.message.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: '[tool call interrupted; session recovered]',
        },
        {
          type: 'tool_result',
          tool_use_id: 'tu-2',
          content: '[tool call interrupted; session recovered]',
        },
      ]);
      expect(repairEvents).toContainEqual(
        expect.objectContaining({
          type: 'orphan_tool_results_repaired',
          count: 2,
          source: 'recovered',
        }),
      );
    });

    // ④ 【孤儿修复—turn 起点（abort source）】
    it('orphan repair: abort 造孤儿 → 下一 turn 起点写 aborted 内容 + emit source:abort', async () => {
      // 手工模拟：上一 turn abort 遗留一条 assistant 含 tool_use 且带 abortMeta
      await sessionManager.appendMessage('main', {
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
        sessionKey: 'main',
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
      const records = sessionManager.getMessages('main');
      const toolResultRecord = records.find(r => r.message.role === 'toolResult');
      expect(toolResultRecord).toBeDefined();
      const trContent = toolResultRecord!.message.content as Array<{ type: string; tool_use_id: string; content: string }>;
      expect(trContent[0]!.tool_use_id).toBe('orphan-1');
      // Option 1: 统一中性 content，不区分 abort vs recovered——source 字段承担区分职责
      expect(trContent[0]!.content).toBe('[tool call interrupted; session recovered]');
    });

    // ⑤ 【孤儿修复—非-abort 来源（recovered）】
    it('orphan repair: 无 abortMeta 孤儿（模拟崩溃恢复）→ 写 recovered 内容 + emit source:recovered', async () => {
      // 预置一条无 abortMeta 的 assistant 含 tool_use 孤儿（模拟进程崩溃）
      await sessionManager.appendMessage('main', {
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
        sessionKey: 'main',
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-repair-recovered',
      });

      const repairEvent = events.find(e => e.type === 'orphan_tool_results_repaired');
      expect(repairEvent).toBeDefined();
      expect((repairEvent as { source: string }).source).toBe('recovered');

      const records = sessionManager.getMessages('main');
      const toolResultRecord = records.find(r => r.message.role === 'toolResult');
      const trContent = toolResultRecord!.message.content as Array<{ tool_use_id: string; content: string }>;
      expect(trContent[0]!.content).toBe('[tool call interrupted; session recovered]');
    });

    // ⑥ 【孤儿修复—no-op】
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
        sessionKey: 'main',
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-no-orphan',
      });

      // 没有 orphan_tool_results_repaired 事件
      expect(events.find(e => e.type === 'orphan_tool_results_repaired')).toBeUndefined();
      // appendMessage 调用中不应有 role='toolResult' 的调用（因为不存在真实 tool_use）
      const toolResultCalls = appendSpy.mock.calls.filter(c => (c[1] as { role: string }).role === 'toolResult');
      expect(toolResultCalls).toHaveLength(0);
    });

    // ⑦ 【孤儿修复—write 失败不 crash】
    it('orphan repair: write 失败 → log warn，turn 继续启动（不 rethrow）', async () => {
      // 预置一个孤儿
      await sessionManager.appendMessage('main', {
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

      // 让 appendMessage 在 repair 阶段（role='toolResult'）抛错，其他角色正常
      const originalAppend = sessionManager.appendMessage.bind(sessionManager);
      const appendSpy = vi.spyOn(sessionManager, 'appendMessage').mockImplementation(async (key, msg) => {
        if (msg.role === 'toolResult') {
          throw new Error('disk full');
        }
        return originalAppend(key, msg);
      });

      const runner = new AgentRunner({ llmClient, sessionManager });

      const result = await runner.run({
        sessionKey: 'main',
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-repair-fail',
      });

      // turn 未 crash，正常完成
      expect(result.stopReason).toBe('end_turn');
      expect(result.text).toBe('still ok');
      appendSpy.mockRestore();
    });

    // ⑧ 【孤儿修复—partial-assistant 写盘失败边角（从磁盘为真的免疫属性）】
    it('orphan repair: partial-assistant 写盘失败 → 磁盘无 assistant → 下轮 repair no-op', async () => {
      const controller = new AbortController();

      // 让 assistant 写盘抛 IO error（模拟磁盘满）
      const originalAppend = sessionManager.appendMessage.bind(sessionManager);
      const appendSpy = vi.spyOn(sessionManager, 'appendMessage').mockImplementation(async (key, msg) => {
        if (msg.role === 'assistant') {
          throw new Error('disk full');
        }
        return originalAppend(key, msg);
      });

      // 第一 turn：LLM 中途 abort（触发 partial assistant 写路径）
      const llmClient1: LLMClient = {
        async *chatStream(params: ChatParams) {
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
        sessionKey: 'main',
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-partial-fail',
        signal: controller.signal,
      });

      // §4 never throws + 走 isAbortError fallback → aborted
      expect(result1.stopReason).toBe('aborted');

      // 磁盘上只有 user（assistant 写失败），无孤儿
      const recordsAfterAbort = sessionManager.getMessages('main');
      expect(recordsAfterAbort.map(r => r.message.role)).toEqual(['user']);

      appendSpy.mockRestore();

      // 第二 turn：起点 repair 应 no-op（因为磁盘没有孤儿）
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
        sessionKey: 'main',
        message: 'retry',
        model: 'test',
        systemPrompt: '',
        turnId: 't-partial-fail-retry',
      });

      expect(events.find(e => e.type === 'orphan_tool_results_repaired')).toBeUndefined();
    });

    // ⑨ 【R2 usage 累计】
    it('R2 usage 累计: abort 前跑过 3 轮 tool → 返回 usage 累计值，非 0/0', async () => {
      const controller = new AbortController();
      let round = 0;

      // 每次 chatStream 调用返回一轮 mock usage {100,50}
      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          round++;
          yield { type: 'message_start' };
          if (round < 4) {
            // 前 3 轮：返回 tool_use 触发下一轮
            yield { type: 'tool_use', id: `tu-${round}`, name: 'echo', input: {} };
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 50 } };
          } else {
            // 第 4 轮：LLM stream abort（partial stream 分支）
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
        sessionKey: 'main',
        message: 'go',
        model: 'test',
        systemPrompt: '',
        turnId: 't-usage-accum',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // 3 轮 tool + partial stream 分支的 usage {0,0}
      expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 150 });
      expect(result.toolRounds).toBe(3);
    });

    // ⑩ 【R8 partial tool_use 完整性】
    it('R8 partial tool_use: stream 到 tool_use 之前 abort → assistant 内容不含残缺 tool_use', async () => {
      const controller = new AbortController();

      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'thinking…' };
          // 在下发 tool_use（AnthropicClient 只在 content_block_stop 才 yield 完整 tool_use）
          // 之前 abort：mock 层不发 tool_use 事件，直接抛 AbortError
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
        sessionKey: 'main',
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-r8',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // session 里 assistant 消息只含 text，不含任何 tool_use
      const records = sessionManager.getMessages('main');
      const assistant = records.find(r => r.message.role === 'assistant')!;
      const content = assistant.message.content as Array<{ type: string }>;
      expect(content.every(b => b.type === 'text')).toBe(true);
      expect(content.some(b => b.type === 'tool_use')).toBe(false);
    });

    // ⑪ 【R11 isAbortError fallback + 诊断 log】
    it('R11 fallback: NetworkError + signal.aborted → 走 abort 分支 + log.warn 命中', async () => {
      const controller = new AbortController();
      const agentLogger = (await import('../../platform/logger/index.js')).Logger.get('AgentRunner');
      const warnSpy = vi.spyOn(agentLogger, 'warn');

      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          yield { type: 'message_start' };
          controller.abort();
          // 名字不是 AbortError（模拟 SDK 内部把 err.name 吞成 NetworkError），
          // 但 signal.aborted 为真 → isAbortError fallback 命中
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
        sessionKey: 'main',
        message: 'hi',
        model: 'test',
        systemPrompt: '',
        turnId: 't-r11',
        signal: controller.signal,
      });

      expect(result.stopReason).toBe('aborted');
      // warn log 被调用，携带 errName='NetworkError'
      const swallowedCall = warnSpy.mock.calls.find(
        c => c[0] === 'non-abort error swallowed by abort fallback',
      );
      expect(swallowedCall).toBeDefined();
      expect((swallowedCall![1] as { errName: string }).errName).toBe('NetworkError');
      warnSpy.mockRestore();
    });

    // R11 对照组：真 AbortError 不应触发该 warn log
    it('R11 对照组: 真 AbortError 名字 → 不触发 fallback warn log', async () => {
      const controller = new AbortController();
      const agentLogger = (await import('../../platform/logger/index.js')).Logger.get('AgentRunner');
      const warnSpy = vi.spyOn(agentLogger, 'warn');

      const llmClient: LLMClient = {
        async *chatStream(params: ChatParams) {
          yield { type: 'message_start' };
          controller.abort();
          if (params.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError'; // 名字命中主判据
            throw err;
          }
        },
        async chat() { throw new Error('Not used'); },
      };

      const runner = new AgentRunner({ llmClient, sessionManager });
      await runner.run({
        sessionKey: 'main',
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

    // 【pending steering log-only】runAttempt 内 pendingSteering 非空时命中 abort →
    // 触发 log.info('dropped pending steering on abort', ...)。核心 §7.2.3 行为。
    // 注：spec §14.1 把这条列在 RuntimeApp tests，实际行为发生在 AgentRunner，故此处实现。
    it('pending steering log-only: pendingSteering 非空时命中 abort 触发 log.info', async () => {
      const controller = new AbortController();
      const agentLogger = (await import('../../platform/logger/index.js')).Logger.get('AgentRunner');
      const infoSpy = vi.spyOn(agentLogger, 'info');

      // 触发链路：第一轮 LLM 返回 tool_use → 跑完 tool → 拉 steering 消息（3 条）→
      // 进入下一轮 while 迭代顶部时 signal 已 abort，命中丢弃分支。
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
          // tool 跑完后 abort → 下一轮 while 顶命中 signal check
          controller.abort();
          return { content: 'ok' };
        },
      });

      await runner.run({
        sessionKey: 'main',
        message: 'go',
        model: 'test',
        systemPrompt: '',
        turnId: 't-pending-steering',
        signal: controller.signal,
        // getSteeringMessages 返回 3 条 steering，触发 pendingSteering 非空
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
