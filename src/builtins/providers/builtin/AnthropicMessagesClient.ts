import { randomUUID } from 'crypto';
import type {
  ChatMessage,
  ChatToolDefinition,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
  ProviderReplayState,
  ReplayJsonValue,
} from '../../../core/model-invocation/index.js';
import { renderExecutionAcceptedReceipt } from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';
import { DEFAULT_ANTHROPIC_MAX_TOKENS } from './config.js';
import type { AnthropicThinkingAdapter } from './config.js';
import {
  asRecord,
  collectChat,
  createHttpError,
  createInvalidRequestError,
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

export type AnthropicMessagesClientOptions = ProtocolClientOptions & {
  readonly thinkingAdapters?: ReadonlyMap<string, AnthropicThinkingAdapter>;
};

const ANTHROPIC_THINKING_REPLAY_FORMAT = 'anthropic-messages.thinking-block.v1';

export class AnthropicMessagesClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicMessagesClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const invocationId = request.invocationId ?? randomUUID();
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
        body: JSON.stringify(buildRequest(
          request,
          maxTokens,
          this.options.baseURL,
          this.options.thinkingAdapters?.get(request.model),
        )),
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
      let currentThinking: {
        blockId: string;
        text: string;
        signature: string;
      } | undefined;
      let currentRedacted: { blockId: string; data: string } | undefined;
      let thinkingBlockIndex = 0;
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
            const responseModelId = readString(message?.model);
            yield {
              type: 'message_start',
              invocation: {
                id: invocationId,
                source: {
                  providerId: 'builtin',
                  connectionId: this.options.baseURL,
                  requestModelId: request.model,
                  wireProtocol: 'anthropic-messages',
                  ...(responseModelId === undefined ? {} : { responseModelId }),
                },
              },
            };
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
            } else if (block?.type === 'thinking') {
              if (currentThinking || currentRedacted) {
                throw new Error('Anthropic started overlapping Thinking blocks.');
              }
              const initialText = block.thinking === undefined
                ? ''
                : readString(block.thinking);
              if (initialText === undefined) {
                throw new Error('Anthropic Thinking block text is invalid.');
              }
              const blockId = `thinking-${thinkingBlockIndex++}`;
              currentThinking = { blockId, text: initialText, signature: '' };
              yield { type: 'thinking_start', blockId };
              if (initialText) {
                yield { type: 'thinking_delta', blockId, text: initialText };
              }
            } else if (block?.type === 'redacted_thinking') {
              if (currentThinking || currentRedacted) {
                throw new Error('Anthropic started overlapping Thinking blocks.');
              }
              const data = readNonEmptyString(
                block.data,
                'Anthropic redacted Thinking data',
              );
              const blockId = `thinking-${thinkingBlockIndex++}`;
              currentRedacted = { blockId, data };
              yield { type: 'thinking_start', blockId };
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
            } else if (delta?.type === 'thinking_delta') {
              if (!currentThinking) {
                throw new Error('Anthropic sent Thinking text without a Thinking block.');
              }
              const text = readString(delta.thinking);
              if (text === undefined) throw new Error('Anthropic Thinking delta is invalid.');
              currentThinking.text += text;
              yield {
                type: 'thinking_delta',
                blockId: currentThinking.blockId,
                text,
              };
            } else if (delta?.type === 'signature_delta') {
              if (!currentThinking) {
                throw new Error('Anthropic sent a signature without a Thinking block.');
              }
              const signature = readString(delta.signature);
              if (signature === undefined) {
                throw new Error('Anthropic Thinking signature delta is invalid.');
              }
              currentThinking.signature += signature;
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
            } else if (currentThinking) {
              if (!currentThinking.signature) {
                throw new Error('Anthropic completed Thinking without a signature.');
              }
              const thinking = currentThinking;
              currentThinking = undefined;
              yield {
                type: 'thinking_end',
                blockId: thinking.blockId,
                completion: {
                  status: 'complete',
                  text: thinking.text,
                  replay: {
                    format: ANTHROPIC_THINKING_REPLAY_FORMAT,
                    payload: anthropicReplayPayload({
                      type: 'thinking',
                      thinking: thinking.text,
                      signature: thinking.signature,
                    }),
                  },
                },
              };
            } else if (currentRedacted) {
              const redacted = currentRedacted;
              currentRedacted = undefined;
              yield {
                type: 'thinking_end',
                blockId: redacted.blockId,
                completion: {
                  status: 'complete',
                  text: '',
                  replay: {
                    format: ANTHROPIC_THINKING_REPLAY_FORMAT,
                    payload: anthropicReplayPayload({
                      type: 'redacted_thinking',
                      data: redacted.data,
                    }),
                  },
                },
              };
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
            if (currentThinking || currentRedacted) {
              throw new Error('Anthropic stopped during a Thinking block.');
            }
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
  connectionId: string,
  adapter: AnthropicThinkingAdapter | undefined,
): Record<string, unknown> {
  const reasoning = buildAnthropicReasoning(request, maxTokens, adapter);
  return {
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    messages: convertMessages(request.messages, connectionId),
    ...(request.system ? { system: request.system } : {}),
    ...(request.tools?.length ? { tools: convertTools(request.tools) } : {}),
    ...(reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking }),
    ...(reasoning.effort === undefined
      ? {}
      : { output_config: { effort: reasoning.effort } }),
  };
}

function buildAnthropicReasoning(
  request: ModelInvocationRequest,
  maxTokens: number,
  adapter: AnthropicThinkingAdapter | undefined,
): {
  thinking?: Record<string, unknown>;
  effort?: string;
} {
  const policy = request.reasoning;
  if (!policy || (policy.thinking === undefined && policy.effort === 'default')) {
    return {};
  }
  if (!adapter) {
    throw createInvalidRequestError(
      request,
      'Anthropic Messages has no adapter for the requested reasoning policy.',
      maxTokens,
    );
  }
  if (policy.thinking === 'off' || policy.effort === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  if (adapter.mode === 'adaptive') {
    return {
      thinking: { type: 'adaptive' },
      ...(policy.effort === 'default' ? {} : { effort: policy.effort }),
    };
  }
  const budgetTokens = policy.effort === 'default'
    ? adapter.defaultBudgetTokens
    : adapter.budgets?.[policy.effort];
  if (budgetTokens === undefined) {
    throw createInvalidRequestError(
      request,
      'Anthropic Messages has no budget for the requested reasoning policy.',
      maxTokens,
    );
  }
  if (budgetTokens >= maxTokens) {
    throw createInvalidRequestError(
      request,
      'Anthropic Thinking budget must be lower than max_tokens.',
      maxTokens,
    );
  }
  return {
    thinking: {
      type: 'enabled',
      budget_tokens: budgetTokens,
    },
  };
}

function convertMessages(
  messages: readonly ChatMessage[],
  connectionId: string,
): unknown[] {
  const output: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      output.push({
        role: message.origin === 'host' ? 'user' : message.role,
        content: message.content,
      });
      continue;
    }
    const content = message.content.flatMap((block): unknown[] => {
      if (block.type === 'thinking') {
        if (message.role !== 'assistant') {
          throw new Error('Anthropic Messages cannot project Thinking on a user message.');
        }
        if (block.status === 'partial') return [];
        if (message.invocation?.source.wireProtocol !== 'anthropic-messages') return [];
        assertAnthropicReplaySource(message, block.id, connectionId);
        return [readAnthropicReplay(block.replay)];
      }
      if (block.type === 'image') return [{ type: 'image', source: block.source }];
      if (block.type === 'tool_result') {
        return [{
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        }];
      }
      if (block.type === 'execution_accepted') {
        return [{
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: renderExecutionAcceptedReceipt({
            executionId: block.execution_id,
            status: 'accepted',
          }),
        }];
      }
      return [block];
    });
    if (!content.length) continue;
    output.push({
      role: message.origin === 'host' ? 'user' : message.role,
      content,
    });
  }
  return output;
}

function assertAnthropicReplaySource(
  message: ChatMessage,
  thinkingId: string,
  connectionId: string,
): void {
  const invocation = message.invocation;
  if (
    !invocation
    || !thinkingId.startsWith(`${invocation.id}:`)
    || invocation.source.providerId !== 'builtin'
    || invocation.source.connectionId !== connectionId
    || invocation.source.wireProtocol !== 'anthropic-messages'
  ) {
    throw new Error('Anthropic Messages replay source is unsupported.');
  }
}

function readAnthropicReplay(
  replay: ProviderReplayState,
): { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string } {
  if (replay.format !== ANTHROPIC_THINKING_REPLAY_FORMAT) {
    throw new Error('Anthropic Messages received unsupported replay state.');
  }
  if (replay.payload.type === 'thinking') {
    if (
      typeof replay.payload.thinking !== 'string'
      || typeof replay.payload.signature !== 'string'
      || replay.payload.signature.length === 0
    ) {
      throw new Error('Anthropic Messages Thinking replay is invalid.');
    }
    return {
      type: 'thinking',
      thinking: replay.payload.thinking,
      signature: replay.payload.signature,
    };
  }
  if (
    replay.payload.type === 'redacted_thinking'
    && typeof replay.payload.data === 'string'
    && replay.payload.data.length > 0
  ) {
    return { type: 'redacted_thinking', data: replay.payload.data };
  }
  throw new Error('Anthropic Messages redacted Thinking replay is invalid.');
}

function anthropicReplayPayload(
  block: { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string },
): { [key: string]: ReplayJsonValue } {
  return { ...block };
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
