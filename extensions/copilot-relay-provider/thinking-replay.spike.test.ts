import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatMessage,
  ModelInvocationPort,
  ModelInvocationRequest,
} from '../../src/core/model-invocation/index.js';
import { CopilotRelayResponsesClient } from './responses-client.js';
import { AnthropicMessagesClient } from '../../src/builtins/providers/builtin/AnthropicMessagesClient.js';
import { BuiltinLlmProvider } from '../../src/builtins/providers/builtin/BuiltinLlmProvider.js';
import { OpenAIResponsesClient } from '../../src/builtins/providers/builtin/OpenAIResponsesClient.js';
import { OpenAIChatCompletionsClient } from '../../src/builtins/providers/builtin/OpenAIChatCompletionsClient.js';
import type { BuiltinProtocol } from '../../src/builtins/providers/builtin/config.js';
import { SessionManager } from '../../src/core/session/SessionManager.js';
import { pruneToolResults } from '../../src/core/runner/context/tool-result-pruning.js';

// Characterization only: fake upstream acceptance is not evidence of API compatibility.
const model = 'fixture-model';
const request: ModelInvocationRequest = {
  model,
  messages: [{ role: 'user', content: 'Look up two fixture values.' }],
  tools: [{ name: 'lookup', description: 'Fixture lookup', inputSchema: { type: 'object' } }],
};

function sse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('Thinking prefix spike: existing persistence and request projection', () => {
  const limits = { toolResultHeadChars: 16, toolResultTailChars: 8 };
  const pruning = { ...limits, toolResultContextShare: 0.5 };
  const toolOutput = 'H'.repeat(16) + 'M'.repeat(600) + 'T'.repeat(8);
  const fixtureMessages = (): ChatMessage[] => [
    { role: 'user', content: '[Prepared context]\nLook up a fixture value.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }] },
    { role: 'user', content: [{
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: toolOutput,
      status: 'success',
    }] },
  ];

  it.each([false, true])('compares live, persisted and reloaded request bodies (persistence cap: %s)', async (capped) => {
    const home = await mkdtemp(join(tmpdir(), 'thinking-prefix-spike-'));
    try {
      const sessionId = randomUUID();
      const manager = new SessionManager(home, capped ? limits : {});
      await manager.materializeSession({ sessionId, createdAt: Date.now() });
      const messages = fixtureMessages();
      for (const [index, message] of messages.entries()) {
        await manager.appendMessage(sessionId, {
          turnId: 'fixture-turn',
          role: index === 2 ? 'toolResult' : message.role,
          content: message.content,
        });
      }
      const loadMessages = (source: SessionManager): ChatMessage[] =>
        source.getMessages(sessionId).map(({ message }) => ({
          role: message.role === 'toolResult' ? 'user' : message.role,
          content: message.content,
        }));
      const persisted = loadMessages(manager);
      const restored = new SessionManager(home, capped ? limits : {});
      await restored.initialize();
      const reloaded = loadMessages(restored);
      expect(reloaded).toEqual(persisted);
      expect(reloaded[0]).toEqual(messages[0]);
      expect(reloaded[1]).toEqual(messages[1]);
      expect(persisted[2]).toEqual({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: capped
            ? `${'H'.repeat(16)}\n\n...\n\n${'T'.repeat(8)}`
              + '\n\n[Tool result trimmed: kept first 16 and last 8 of 624 chars]'
            : toolOutput,
          status: 'success',
        }],
      });

      const bodies: unknown[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return anthropicTool(2, true);
      };
      for (const history of [messages, persisted, reloaded]) {
        const client = new AnthropicMessagesClient({ baseURL: 'https://fixture.invalid', fetch: fetchImpl });
        await client.chat({
          ...request,
          system: 'Fixed synthetic system.',
          messages: pruneToolResults(history, pruning, 10_000),
        });
      }
      expect(bodies[1]).toEqual(bodies[2]);
      if (capped) {
        expect(bodies[0]).not.toEqual(bodies[2]);
      } else {
        expect(bodies[0]).toEqual(bodies[2]);
      }
      expect(messages).toEqual(fixtureMessages());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('changing the input budget can rewrite an existing tool result without changing Transcript input', () => {
    const messages = fixtureMessages();
    const originalProjection = pruneToolResults(messages, pruning, 10_000);
    const smallerBudgetProjection = pruneToolResults(messages, pruning, 200);
    expect(originalProjection).toEqual(messages);
    expect(smallerBudgetProjection[2]).not.toEqual(originalProjection[2]);
    expect(smallerBudgetProjection.slice(0, 2)).toEqual(originalProjection.slice(0, 2));
    expect(messages).toEqual(fixtureMessages());
  });
});

function anthropicTool(index: number, signed: boolean): Response {
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture thought.' } },
    ...(signed ? [
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-sig-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: String(index) } },
    ] : []),
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'fixture-redacted' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: `call-${index}`, name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]);
}

function responsesTool(index: number, summary: boolean): Response {
  const item = {
    type: 'reasoning',
    id: `rs-${index}`,
    summary: summary ? [{ type: 'summary_text', text: 'Fixture thought.' }] : [],
    encrypted_content: `fixture-cipher-${index}`,
  };
  return sse([
    { type: 'response.created', response: { id: `response-${index}` } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: item.id, summary: [] } },
    ...(summary ? [{
      type: 'response.reasoning_summary_text.delta',
      item_id: item.id,
      summary_index: 0,
      delta: 'Fixture thought.',
    }] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: `fc-${index}`, call_id: `call-${index}`, name: 'lookup', arguments: '{}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 10 } } },
  ]);
}

async function appendToolRound(client: ModelInvocationPort, messages: ChatMessage[], index: number) {
  const result = await client.chat({ ...request, messages });
  expect(result.stopReason).toBe('tool_use');
  expect(result.content).toContainEqual({
    type: 'tool_use',
    id: `call-${index}`,
    name: 'lookup',
    input: {},
  });
  messages.push(
    {
      role: 'assistant',
      content: result.content,
      ...(result.invocation === undefined ? {} : { invocation: result.invocation }),
    },
    { role: 'user', content: [{
      type: 'tool_result',
      tool_use_id: `call-${index}`,
      content: `value-${index}`,
      status: 'success',
    }] },
  );
}

describe('Thinking replay spike', () => {
  it('Chat Completions preserves and replays the gateway reasoning_opaque field', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const events = [
        { choices: [{ index: 0, delta: {
          role: 'assistant', content: null, reasoning_opaque: 'fixture-chat-opaque',
          tool_calls: [{ index: 0, id: `call-${bodies.length}`, type: 'function',
            function: { name: 'lookup', arguments: '{}' } }],
        } }] },
        { choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, reasoning_tokens: 6, total_tokens: 20 } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const client = new OpenAIChatCompletionsClient({ baseURL: 'https://fixture.invalid', fetch: fetchImpl });
    const messages = structuredClone(request.messages);
    await appendToolRound(client, messages, 1);
    await appendToolRound(client, messages, 2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ messages: [
      request.messages[0],
      {
        role: 'assistant',
        content: null,
        reasoning_opaque: 'fixture-chat-opaque',
        tool_calls: [{
          id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'value-1' },
    ] });
    expect(JSON.stringify(messages)).toContain('fixture-chat-opaque');
  });

  it.each([true, false])('Anthropic currently loses thinking/redacted state (signature present: %s)', async (signed) => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return anthropicTool(bodies.length, signed);
    };
    const createClient = () => new AnthropicMessagesClient({ baseURL: 'https://fixture.invalid', fetch: fetchImpl });
    const messages = structuredClone(request.messages);
    const client = createClient();
    await appendToolRound(client, messages, 1);
    await appendToolRound(client, messages, 2);
    await appendToolRound(createClient(), messages, 3);

    expect(bodies[2]).toMatchObject({
      messages: [
        request.messages[0],
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'value-1' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'lookup', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'value-2' }] },
      ],
    });
    expect(JSON.stringify(bodies)).not.toMatch(/fixture-sig|fixture-redacted|Fixture thought/);
    expect(bodies[0]).not.toHaveProperty('thinking');
  });

  for (const Client of [OpenAIResponsesClient, CopilotRelayResponsesClient]) {
    it.each([true, false])(`${Client.name} preserves completed reasoning items (summary present: %s)`, async (summary) => {
      const bodies: unknown[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responsesTool(bodies.length, summary);
      };
      const createClient = () => new Client({ baseURL: 'https://fixture.invalid', fetch: fetchImpl });
      const messages = structuredClone(request.messages);
      const client = createClient();
      await appendToolRound(client, messages, 1);
      await appendToolRound(client, messages, 2);
      await appendToolRound(createClient(), messages, 3);

      expect(bodies[2]).toMatchObject({
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Look up two fixture values.' }] },
          {
            type: 'reasoning',
            id: 'rs-1',
            summary: summary ? [{ type: 'summary_text', text: 'Fixture thought.' }] : [],
            encrypted_content: 'fixture-cipher-1',
          },
          { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'value-1' },
          {
            type: 'reasoning',
            id: 'rs-2',
            summary: summary ? [{ type: 'summary_text', text: 'Fixture thought.' }] : [],
            encrypted_content: 'fixture-cipher-2',
          },
          { type: 'function_call', call_id: 'call-2', name: 'lookup', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-2', output: 'value-2' },
        ],
      });
      for (const body of bodies) {
        expect(body).not.toHaveProperty('store');
        expect(body).not.toHaveProperty('previous_response_id');
        expect(body).not.toHaveProperty('include');
        expect(body).not.toHaveProperty('reasoning');
      }
      expect(JSON.stringify(messages)).toMatch(/fixture-cipher-1|rs-1/);
    });
  }

  it('resolved identity/protocol do not identify the actual Built-in wire protocol or auth scope', () => {
    const descriptor = (protocol: BuiltinProtocol, baseURL: string, apiKey: string) => {
      const provider = new BuiltinLlmProvider({
        baseURL,
        apiKey,
        models: [{ modelId: model, protocol }],
      });
      const connection = provider.entry.resolveConnection();
      if (!connection.ok) throw new Error(connection.message);
      const resolved = provider.entry.resolveModel(model, connection.connection);
      if (!resolved.ok) throw new Error(resolved.message);
      return resolved.descriptor;
    };
    const original = descriptor('anthropic-messages', 'https://fixture.invalid', 'fixture-key-a');
    expect(descriptor('openai-responses', 'https://fixture.invalid', 'fixture-key-a')).toEqual(original);
    expect(descriptor('anthropic-messages', 'https://fixture.invalid', 'fixture-key-b')).toEqual(original);
    expect(descriptor('anthropic-messages', 'https://different.invalid', 'fixture-key-a').connection)
      .not.toEqual(original.connection);
    expect(original.protocol).toBe('builtin-model-router');
  });
});
