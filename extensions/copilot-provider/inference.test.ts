import { describe, expect, it, vi } from 'vitest';
import type { ModelInvocationRequest, ModelStreamEvent } from 'my-agent/extension-api';
import { CopilotInferenceClient } from './inference.js';
import type { CopilotModelBinding, CopilotWireProtocol } from './model-metadata.js';
import { COPILOT_PROVIDER_ID } from './model-metadata.js';

function binding(wireProtocol: CopilotWireProtocol): CopilotModelBinding {
  return {
    modelId: 'test-model', apiBase: 'https://copilot.invalid', wireProtocol,
    facts: { effectiveContextLimit: 32_000, maximumOutputTokens: 4096, toolUse: true, mediaKinds: ['image'] },
  };
}
const request: ModelInvocationRequest = { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] };
function stream(events: unknown[], split = false): Response {
  const bytes = new TextEncoder().encode(events.map((event) =>
    `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({
    start(controller) {
      if (split) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      else controller.enqueue(bytes);
      controller.close();
    },
  }));
}
function chatEvents(argumentsText?: string) {
  return [
    { choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
    ...(argumentsText === undefined ? [] : [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: argumentsText.slice(0, 3) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(3) } }] }, finish_reason: null }] },
    ]),
    { choices: [{ index: 0, delta: {}, finish_reason: argumentsText === undefined ? 'stop' : 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }, '[DONE]',
  ];
}
function responsesEvents() {
  return [
    { type: 'response.created', response: { id: 'response-1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reason-1' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'reason-1', summary_index: 0, delta: 'Checking.' },
    { type: 'response.output_item.done', output_index: 0, item: {
      type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'Checking.' }],
      encrypted_content: 'synthetic-opaque', status: 'completed',
    } },
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"key":"value"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 7 } } },
  ];
}

describe('Copilot native inference', () => {
  it('streams split UTF-8 Chat deltas and complete tool calls with exact usage and invocation identity', async () => {
    const send = vi.fn(async () => stream(chatEvents('{"key":"value"}'), true));
    const client = new CopilotInferenceClient(binding('openai-chat-completions'), send, new AbortController().signal);
    const result = await client.chat({
      ...request, invocationId: 'invoke-1', system: 'Be concise.', outputTokenLimit: 32,
      tools: [{ name: 'lookup', description: 'Look up a key.', inputSchema: { type: 'object' } }],
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'call-1', name: 'lookup', input: { key: 'value' } }],
      toolCalls: [{ callId: 'call-1', name: 'lookup', input: { state: 'ready', value: { key: 'value' } } }],
      usage: { inputTokens: 11, outputTokens: 7 }, stopReason: 'tool_use',
      invocation: { id: 'invoke-1', source: { providerId: COPILOT_PROVIDER_ID, wireProtocol: 'openai-chat-completions' } },
    });
    expect(send.mock.calls).toHaveLength(1);
  });

  it.each([
    ['broken json', 'malformed_json'], ['[]', 'not_an_object'],
  ])('preserves invalid tool input as canonical %s rather than substituting an empty object', async (argumentsText, reason) => {
    const client = new CopilotInferenceClient(binding('openai-chat-completions'),
      async () => stream(chatEvents(argumentsText)), new AbortController().signal);
    expect((await client.chat(request)).toolCalls[0]?.input).toEqual({ state: 'invalid', reason });
  });

  it('keeps Responses reasoning opaque data, tool calls and stateless replay through a tool round', async () => {
    const send = vi.fn<(body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>>()
      .mockImplementation(async () => stream(responsesEvents()));
    const client = new CopilotInferenceClient(binding('openai-responses'), send, new AbortController().signal);
    const first = await client.chat({ ...request, invocationId: 'invoke-1', outputTokenLimit: 32 });
    expect(first.stopReason).toBe('tool_use');
    expect(first.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(first.content[0]).toMatchObject({
      type: 'thinking', id: 'invoke-1:thinking-0', status: 'complete',
      replay: { payload: { item: { encrypted_content: 'synthetic-opaque' } } },
    });
    await client.chat({
      ...request, invocationId: 'invoke-2',
      messages: [
        ...request.messages,
        { role: 'assistant', content: first.content, invocation: first.invocation },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', status: 'success', content: 'Result' }] },
      ],
    });
    expect(send.mock.calls[0]![0]).toMatchObject({ store: false, max_output_tokens: 32, include: ['reasoning.encrypted_content'] });
    expect(send.mock.calls[1]![0].input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'synthetic-opaque' }));
    expect(send.mock.calls[1]![0].input).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: 'Result' });
    expect(JSON.stringify(send.mock.calls[1]![0])).not.toContain('invocation');
  });

  it('replays Chat reasoning and tool results without leaking internal image/invocation fields', async () => {
    const send = vi.fn<(body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>>()
      .mockImplementation(async () => stream([
        { choices: [{ index: 0, delta: { reasoning_text: 'Checking.', reasoning_opaque: 'synthetic-opaque' }, finish_reason: null }] },
        ...chatEvents(),
      ]));
    const client = new CopilotInferenceClient(binding('openai-chat-completions'), send, new AbortController().signal);
    const first = await client.chat(request);
    await client.chat({
      ...request,
      messages: [
        { role: 'assistant', content: first.content, invocation: first.invocation },
        { role: 'user', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic-image' },
          dimensions: { width: 10, height: 20 },
        }, { type: 'execution_accepted', tool_use_id: 'call-1', execution_id: 'execution-1' }] },
      ],
    });
    expect(send.mock.calls[1]![0].messages).toContainEqual(expect.objectContaining({ reasoning_text: 'Checking.', reasoning_opaque: 'synthetic-opaque' }));
    expect(JSON.stringify(send.mock.calls[1]![0])).not.toMatch(/dimensions|invocation/);
    expect(send.mock.calls[1]![0]).not.toHaveProperty('max_tokens');
  });

  it.each(['openai-chat-completions', 'openai-responses'] as const)('rejects truncated %s streams with partial thinking, not a successful terminal', async (protocol) => {
    const events = protocol === 'openai-chat-completions'
      ? [{ choices: [{ index: 0, delta: { reasoning_text: 'Partial' }, finish_reason: null }] }]
      : responsesEvents().slice(0, 3);
    const client = new CopilotInferenceClient(binding(protocol), async () => stream(events), new AbortController().signal);
    const output: ModelStreamEvent[] = [];
    for await (const event of client.chatStream(request)) output.push(event);
    expect(output.some((event) => event.type === 'thinking_end' && event.completion.status === 'partial')).toBe(true);
    expect(output.at(-1)).toMatchObject({ type: 'error' });
    expect(output.some((event) => event.type === 'message_end')).toBe(false);
  });

  it.each([
    [401, 'authentication'], [403, 'authentication'], [429, 'rate_limit'], [503, 'unavailable'],
  ])('reports HTTP %s as %s without reflecting response secrets', async (status, category) => {
    const client = new CopilotInferenceClient(binding('openai-chat-completions'), async () =>
      new Response('synthetic-secret-not-for-diagnostics', { status }), new AbortController().signal);
    try { await client.chat(request); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toMatchObject({ category, diagnostics: { httpStatus: status } });
      expect(JSON.stringify(error)).not.toContain('synthetic-secret');
    }
  });

  it.each(['caller', 'host'])('cancels a stalled stream on %s abort and closes its reader', async (owner) => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const lifetime = new AbortController();
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n')); },
      cancel: cancelled,
    }));
    const send = vi.fn(async () => response);
    const client = new CopilotInferenceClient(binding('openai-chat-completions'), send, lifetime.signal);
    const events = client.chatStream({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
    expect((await events.next()).value).toHaveProperty('type', 'message_start');
    expect((await events.next()).value).toHaveProperty('type', 'text_delta');
    const pending = events.next();
    (owner === 'caller' ? controller : lifetime).abort();
    expect((await pending).value).toMatchObject({ type: 'error', error: { name: 'AbortError' } });
    await events.return?.();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each([
    { model: 'different-model' }, { outputTokenLimit: 4097 }, { reasoning: { effort: 'default' as const, thinking: 'on' as const } },
  ])('rejects unsupported invocation options before making a request (%j)', async (override) => {
    const send = vi.fn(async () => stream(chatEvents()));
    const client = new CopilotInferenceClient(binding('openai-chat-completions'), send, new AbortController().signal);
    await expect(client.chat({ ...request, ...override })).rejects.toMatchObject({ category: 'invalid_request' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects oversized complete SSE events and structured missing-model errors explicitly', async () => {
    const client = new CopilotInferenceClient(binding('openai-chat-completions'), async () =>
      stream([{ padding: 'x'.repeat(1024 * 1024) }]), new AbortController().signal);
    await expect(client.chat(request)).rejects.toMatchObject({ category: 'provider_failure' });
    const missing = new CopilotInferenceClient(binding('openai-responses'), async () =>
      stream([{ type: 'error', code: 'model_not_found' }]), new AbortController().signal);
    await expect(missing.chat(request)).rejects.toMatchObject({ category: 'model_not_found' });
  });
});
