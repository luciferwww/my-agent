import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentRunner } from './AgentRunner.js';
import { SessionManager } from '../session/SessionManager.js';
import type { LLMClient, ChatParams, ChatResponse, StreamEvent } from '../llm-client/types.js';
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
      await runner.run({ sessionKey: 'main', message: 'First', model: 'test', systemPrompt: '' });

      // 第二轮——应该能看到第一轮的历史
      await runner.run({ sessionKey: 'main', message: 'Second', model: 'test', systemPrompt: '' });

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
      });

      expect(result.text).toBe('Done.');
      expect(result.toolRounds).toBe(2);
    });

    it('respects maxToolRounds limit', async () => {
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
        maxToolRounds: 3,
      });

      // maxToolRounds=3 意味着最多执行 3 轮工具调用
      // 第一次 LLM 调用（hasMoreToolCalls=true）→ tool_use → 执行 → toolRounds=1
      // 第二次 LLM 调用 → tool_use → 执行 → toolRounds=2
      // 第三次 LLM 调用 → tool_use → 执行 → toolRounds=3
      // 第四次 LLM 调用 → tool_use → toolRounds(3) >= maxToolRounds(3) → break
      expect(result.toolRounds).toBe(3);
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
      });

      expect(result.stopReason).toBe('error');
      expect(result.text).toBe('Error occurred');
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

      await runner.run({ sessionKey: 'main', message: 'Hi', model: 'test', systemPrompt: '' });

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

      await runner.run({ sessionKey: 'main', message: 'Hi', model: 'test', systemPrompt: '' });

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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '' });

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

      await runner.run({ sessionKey: 'main', message: 'Go', model: 'test', systemPrompt: '' });

      expect(llmCalls).toEqual([0, 1]);
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
      await runner.run({ sessionKey: 'main', message: 'Hello', model: 'test', systemPrompt: '' });

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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '' });

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
        runner.run({ sessionKey: 'main', message: 'Hi', model: 'test', systemPrompt: '' }),
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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '' });

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

      const result = await runner.run({ sessionKey: 'main', message: 'Run it', model: 'test', systemPrompt: '' });

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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '' });

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

      await runner.run({ sessionKey: 'main', message: 'Search', model: 'test', systemPrompt: '' });

      // after_tool_call is fire-and-forget; give it a tick to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(afterPayloads).toHaveLength(1);
      expect(afterPayloads[0]?.toolName).toBe('search');
      expect(afterPayloads[0]?.durationMs).toBeGreaterThanOrEqual(0);
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

      await runner.run({ sessionKey: 'main', message: 'Go', model: 'test', systemPrompt: '' });

      expect(order).toEqual([10, 1]);
    });

    it('on() supports chaining', () => {
      const runner = new AgentRunner({ llmClient: createMockLLMClient([]), sessionManager });
      const result = runner
        .on('before_tool_call', async () => ({ action: 'allow' }))
        .on('after_tool_call', async () => {});
      expect(result).toBe(runner);
    });
  });
});
