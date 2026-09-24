import type {
  ChatMessage,
  ChatToolDefinition,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';
import { DEFAULT_ANTHROPIC_MAX_TOKENS } from './config.js';
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

export type AnthropicMessagesClientOptions = ProtocolClientOptions;

export class AnthropicMessagesClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicMessagesClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const maxTokens = request.outputTokenLimit ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    try {
      const apiKey = this.options.apiKey?.trim();
      const response = await this.fetchImpl(`${this.options.baseURL}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify(buildRequest(request, maxTokens)),
        signal: request.signal,
      });
      if (!response.ok) {
        throw await createHttpError(response, request, maxTokens);
      }
      if (!response.body) throw new Error('Anthropic streaming response has no body.');

      let started = false;
      let terminal = false;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason = 'end_turn';
      let currentTool: { id: string; name: string; arguments: string } | undefined;
      const seenCallIds = new Set<string>();

      for await (const data of readSseData(response.body, request.signal)) {
        const event = parseRecord(data, 'Anthropic sent malformed SSE JSON.');
        const type = readNonEmptyString(event.type, 'Anthropic event type');
        if (terminal) throw new Error('Anthropic sent an event after message_stop.');
        switch (type) {
          case 'message_start': {
            if (started) throw new Error('Anthropic sent duplicate message_start events.');
            const message = asRecord(event.message);
            const startUsage = asRecord(message?.usage);
            if (startUsage?.input_tokens !== undefined) {
              usage = {
                ...usage,
                inputTokens: readNonNegativeInteger(
                  startUsage.input_tokens,
                  'Anthropic usage.input_tokens',
                ),
              };
            }
            started = true;
            yield { type: 'message_start' };
            break;
          }
          case 'content_block_start': {
            requireStarted(started, type);
            const block = asRecord(event.content_block);
            if (block?.type === 'tool_use') {
              if (currentTool) throw new Error('Anthropic started overlapping Tool Calls.');
              currentTool = {
                id: readNonEmptyString(block.id, 'Anthropic Tool Call id'),
                name: readNonEmptyString(block.name, 'Anthropic Tool Call name'),
                arguments: '',
              };
            }
            break;
          }
          case 'content_block_delta': {
            requireStarted(started, type);
            const delta = asRecord(event.delta);
            if (delta?.type === 'text_delta') {
              const text = readString(delta.text);
              if (text === undefined) throw new Error('Anthropic text delta is invalid.');
              yield { type: 'text_delta', text };
            } else if (delta?.type === 'input_json_delta') {
              if (!currentTool) throw new Error('Anthropic sent Tool input without a Tool Call.');
              const partial = readString(delta.partial_json);
              if (partial === undefined) throw new Error('Anthropic Tool input delta is invalid.');
              currentTool.arguments += partial;
            }
            break;
          }
          case 'content_block_stop':
            requireStarted(started, type);
            if (currentTool) {
              if (seenCallIds.has(currentTool.id)) {
                throw new Error(`Anthropic sent duplicate Tool Call id "${currentTool.id}".`);
              }
              seenCallIds.add(currentTool.id);
              const call: ToolCall = Object.freeze({
                callId: currentTool.id,
                name: currentTool.name,
                input: parseToolInput(currentTool.arguments || '{}'),
              });
              currentTool = undefined;
              yield { type: 'tool_call', call };
            }
            break;
          case 'message_delta': {
            requireStarted(started, type);
            const delta = asRecord(event.delta);
            const nextReason = readString(delta?.stop_reason);
            if (nextReason) stopReason = nextReason;
            const deltaUsage = asRecord(event.usage);
            if (deltaUsage?.output_tokens !== undefined) {
              usage = {
                ...usage,
                outputTokens: readNonNegativeInteger(
                  deltaUsage.output_tokens,
                  'Anthropic usage.output_tokens',
                ),
              };
            }
            break;
          }
          case 'message_stop':
            requireStarted(started, type);
            if (currentTool) throw new Error('Anthropic stopped during a Tool Call.');
            terminal = true;
            break;
          case 'ping':
            break;
          case 'error':
            throw createStreamError(event, request, maxTokens);
          default:
            throw new Error(`Anthropic sent unsupported event "${type}".`);
        }
      }
      if (!started) throw new Error('Anthropic stream ended before message_start.');
      if (!terminal) throw new Error('Anthropic stream ended before message_stop.');
      yield { type: 'message_end', stopReason, usage: Object.freeze(usage) };
    } catch (error) {
      yield {
        type: 'error',
        error: normalizeError(error, request, maxTokens),
      };
    }
  }

  chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    return collectChat(this.chatStream(request));
  }
}

function buildRequest(
  request: ModelInvocationRequest,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    messages: convertMessages(request.messages),
    ...(request.system ? { system: request.system } : {}),
    ...(request.tools?.length ? { tools: convertTools(request.tools) } : {}),
  };
}

function convertMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => {
          if (block.type === 'image') return { type: 'image', source: block.source };
          if (block.type === 'tool_result') {
            return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content };
          }
          return block;
        }),
  }));
}

function convertTools(tools: readonly ChatToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function requireStarted(started: boolean, type: string): void {
  if (!started) throw new Error(`Anthropic sent "${type}" before message_start.`);
}
