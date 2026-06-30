import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentRunner } from './AgentRunner.js';
import { SessionManager } from '../session/SessionManager.js';
import type { LLMClient, ChatParams, ChatResponse, StreamEvent } from '../../adapters/llm/types.js';
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

    it('returns early on error stopReason', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'text_delta', text: 'Error occurred' },
          { type: 'message_end', stopReason: 'error', usage: { inputTokens: 5, outputTokens: 3 } },
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

      expect(result.stopReason).toBe('error');
      expect(result.text).toBe('Error occurred');
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
    it('emits run_start and run_end', async () => {
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

      await runner.run({ sessionKey: 'main', message: 'Hi', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(events[0]!.type).toBe('run_start');
      expect(events[events.length - 1]!.type).toBe('run_end');
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
        expect(e.turnId).toBe('parent-turn');
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
  });

  // ── 错误处理 ────────────────────────────────────────

  describe('error handling', () => {
    it('emits error event and throws on LLM stream error', async () => {
      const llmClient = createMockLLMClient([
        [
          { type: 'message_start' },
          { type: 'error', error: new Error('API error') },
        ],
      ]);

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
    });
  });

  // ── Hook on() API ───────────────────────────────────────

  describe('hooks', () => {
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
      runner.on('before_tool_call', async () => ({ action: 'allow' }));

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      expect(executedTools).toEqual(['search']);
    });

    it('before_tool_call deny blocks tool and returns error to LLM', async () => {
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

    it('after_tool_call fires after execution', async () => {
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

      const afterPayloads: { toolName: string; durationMs: number }[] = [];
      const runner = new AgentRunner({
        llmClient,
        sessionManager,
        toolExecutor: async () => ({ content: 'result' }),
      });
      runner.on('after_tool_call', async ({ toolName, durationMs }) => {
        afterPayloads.push({ toolName, durationMs });
      });

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '', turnId: 'test-turn' });

      // after_tool_call is fire-and-forget; give it a tick to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(afterPayloads).toHaveLength(1);
      expect(afterPayloads[0]?.toolName).toBe('search');
      expect(afterPayloads[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('before_compaction and after_compaction fire around preemptive compaction', async () => {
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

      const beforePayloads: Array<{ trigger: string; estimatedTokens: number }> = [];
      const afterPayloads: Array<{ trigger: string; tokensBefore: number; tokensAfter: number; droppedMessages: number }> = [];
      const runner = new AgentRunner({ llmClient, sessionManager });
      runner.on('before_compaction', async ({ trigger, estimatedTokens }) => {
        beforePayloads.push({ trigger, estimatedTokens });
      });
      runner.on('after_compaction', async ({ trigger, tokensBefore, tokensAfter, droppedMessages }) => {
        afterPayloads.push({ trigger, tokensBefore, tokensAfter, droppedMessages });
      });

      const result = await runner.run({
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

      await new Promise((resolve) => setTimeout(resolve, 10));

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
});
