import type {
  ChatMessage,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';
import {
  asRecord,
  collectChat,
  createHttpError,
  createStreamError,
  normalizeError,
  parseRecord,
  parseToolInput,
  readNonEmptyString,
  readNonNegativeInteger,
  readSseData,
  readString,
  type ProtocolClientOptions,
} from './client-common.js';

export type OpenAIChatCompletionsClientOptions = ProtocolClientOptions;

interface PendingTool {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAIChatCompletionsClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIChatCompletionsClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    try {
      const apiKey = this.options.apiKey?.trim();
      const response = await this.fetchImpl(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildRequest(request)),
        signal: request.signal,
      });
      if (!response.ok) throw await createHttpError(response, request);
      if (!response.body) throw new Error('OpenAI Chat Completions streaming response has no body.');

      let started = false;
      let done = false;
      let finishReason: string | undefined;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      const tools = new Map<number, PendingTool>();
      for await (const data of readSseData(response.body, request.signal)) {
        if (data === '[DONE]') {
          if (done || !finishReason) {
            throw new Error('OpenAI Chat Completions sent an invalid [DONE] marker.');
          }
          done = true;
          continue;
        }
        if (done) throw new Error('OpenAI Chat Completions sent an event after [DONE].');
        const chunk = parseRecord(data, 'OpenAI Chat Completions sent malformed SSE JSON.');
        if (chunk.type === 'error' || chunk.error !== undefined) {
          throw createStreamError(chunk, request);
        }
        if (!started) {
          started = true;
          yield { type: 'message_start' };
        }
        const rawUsage = asRecord(chunk.usage);
        if (rawUsage) {
          usage = {
            inputTokens: readNonNegativeInteger(
              rawUsage.prompt_tokens,
              'OpenAI Chat Completions usage.prompt_tokens',
            ),
            outputTokens: readNonNegativeInteger(
              rawUsage.completion_tokens,
              'OpenAI Chat Completions usage.completion_tokens',
            ),
          };
        }
        const choices = chunk.choices;
        if (!Array.isArray(choices)) {
          throw new Error('OpenAI Chat Completions choices are invalid.');
        }
        for (const choiceValue of choices) {
          const choice = asRecord(choiceValue);
          if (!choice) throw new Error('OpenAI Chat Completions choice is invalid.');
          const index = readNonNegativeInteger(
            choice.index,
            'OpenAI Chat Completions choice.index',
          );
          if (index !== 0) throw new Error('OpenAI Chat Completions returned multiple choices.');
          const delta = asRecord(choice.delta);
          if (!delta) throw new Error('OpenAI Chat Completions choice delta is invalid.');
          const text = readString(delta.content);
          if (text !== undefined) yield { type: 'text_delta', text };
          appendToolDeltas(delta.tool_calls, tools);
          const reason = readString(choice.finish_reason);
          if (reason !== undefined) {
            if (finishReason !== undefined) {
              throw new Error('OpenAI Chat Completions sent duplicate terminal choices.');
            }
            finishReason = reason;
          }
        }
      }
      if (!started) throw new Error('OpenAI Chat Completions stream ended before a response chunk.');
      if (!finishReason) throw new Error('OpenAI Chat Completions stream ended before a terminal choice.');
      if (!usage) throw new Error('OpenAI Chat Completions stream ended without usage.');
      const seenIds = new Set<string>();
      for (const [, pending] of [...tools].sort(([left], [right]) => left - right)) {
        const callId = pending.id.trim();
        const name = pending.name.trim();
        if (!callId || !name) throw new Error('OpenAI Chat Completions Tool Call is incomplete.');
        if (seenIds.has(callId)) {
          throw new Error(`OpenAI Chat Completions sent duplicate Tool Call id "${callId}".`);
        }
        seenIds.add(callId);
        const call: ToolCall = Object.freeze({
          callId,
          name,
          input: parseToolInput(pending.arguments),
        });
        yield { type: 'tool_call', call };
      }
      yield {
        type: 'message_end',
        stopReason: normalizeStopReason(finishReason, tools.size),
        usage: Object.freeze(usage),
      };
    } catch (error) {
      yield { type: 'error', error: normalizeError(error, request) };
    }
  }

  chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    return collectChat(this.chatStream(request));
  }
}

function buildRequest(request: ModelInvocationRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...convertMessages(request.messages),
    ],
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

function convertMessages(messages: readonly ChatMessage[]): unknown[] {
  const output: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      output.push({ role: message.role, content: message.content });
      continue;
    }
    let content: unknown[] = [];
    const toolCalls: unknown[] = [];
    const flushContent = (): void => {
      if (!content.length) return;
      output.push({ role: message.role, content });
      content = [];
    };
    for (const block of message.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else {
        flushContent();
        output.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
      }
    }
    if (toolCalls.length) {
      output.push({
        role: 'assistant',
        content: content.length ? content : null,
        tool_calls: toolCalls,
      });
      content = [];
    }
    flushContent();
  }
  return output;
}

function appendToolDeltas(value: unknown, tools: Map<number, PendingTool>): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('OpenAI Chat Completions Tool deltas are invalid.');
  for (const raw of value) {
    const delta = asRecord(raw);
    if (!delta) throw new Error('OpenAI Chat Completions Tool delta is invalid.');
    const index = readNonNegativeInteger(
      delta.index,
      'OpenAI Chat Completions Tool delta index',
    );
    const current = tools.get(index) ?? { id: '', name: '', arguments: '' };
    const fn = asRecord(delta.function);
    current.id += readString(delta.id) ?? '';
    current.name += readString(fn?.name) ?? '';
    current.arguments += readString(fn?.arguments) ?? '';
    tools.set(index, current);
  }
}

function normalizeStopReason(reason: string, toolCount: number): string {
  if (reason === 'stop') return toolCount ? 'tool_use' : 'end_turn';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'content_filter';
  throw new Error(`OpenAI Chat Completions returned unsupported stop reason "${reason}".`);
}
