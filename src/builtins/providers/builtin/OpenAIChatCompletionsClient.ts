import { randomUUID } from 'crypto';
import type {
  ChatContentBlock,
  ChatMessage,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
  ProviderReplayState,
} from '../../../core/model-invocation/index.js';
import { renderExecutionAcceptedReceipt } from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';
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

export type OpenAIChatCompletionsClientOptions = ProtocolClientOptions & {
  readonly thinkingSwitchModels?: readonly string[];
};

const CHAT_REASONING_REPLAY_FORMAT = 'openai-chat-completions.reasoning.v1';

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
    const invocationId = request.invocationId ?? randomUUID();
    let thinkingStarted = false;
    let thinkingEnded = false;
    let reasoningText = '';
    let reasoningOpaque: string | undefined;
    try {
      const apiKey = this.options.apiKey?.trim();
      const response = await this.fetchImpl(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildRequest(
          request,
          this.options.baseURL,
          this.options.thinkingSwitchModels?.includes(request.model) === true,
        )),
        signal: request.signal,
      });
      if (!response.ok) {
        throw await createHttpError(response, request, request.outputTokenLimit);
      }
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
          throw createStreamError(chunk, request, request.outputTokenLimit);
        }
        if (!started) {
          started = true;
          const responseModelId = readString(chunk.model);
          yield {
            type: 'message_start',
            invocation: {
              id: invocationId,
              source: {
                providerId: 'builtin',
                connectionId: this.options.baseURL,
                requestModelId: request.model,
                wireProtocol: 'openai-chat-completions',
                ...(responseModelId === undefined ? {} : { responseModelId }),
              },
            },
          };
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
          const rawReasoningText = delta.reasoning_text;
          if (rawReasoningText !== undefined && rawReasoningText !== null) {
            if (typeof rawReasoningText !== 'string') {
              throw new Error('OpenAI Chat Completions reasoning_text is invalid.');
            }
            if (rawReasoningText) {
              if (!thinkingStarted) {
                thinkingStarted = true;
                yield { type: 'thinking_start', blockId: 'thinking-0' };
              }
              reasoningText += rawReasoningText;
              yield {
                type: 'thinking_delta',
                blockId: 'thinking-0',
                text: rawReasoningText,
              };
            }
          }
          const rawReasoningOpaque = delta.reasoning_opaque;
          if (rawReasoningOpaque !== undefined && rawReasoningOpaque !== null) {
            if (typeof rawReasoningOpaque !== 'string') {
              throw new Error('OpenAI Chat Completions reasoning_opaque is invalid.');
            }
            if (rawReasoningOpaque) {
              if (reasoningOpaque !== undefined) {
                throw new Error(
                  'OpenAI Chat Completions sent multiple non-empty reasoning_opaque values.',
                );
              }
              reasoningOpaque = rawReasoningOpaque;
              if (!thinkingStarted) {
                thinkingStarted = true;
                yield { type: 'thinking_start', blockId: 'thinking-0' };
              }
            }
          }
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
      if (thinkingStarted) {
        thinkingEnded = true;
        yield {
          type: 'thinking_end',
          blockId: 'thinking-0',
          completion: {
            status: 'complete',
            text: reasoningText,
            replay: {
              format: CHAT_REASONING_REPLAY_FORMAT,
              payload: {
                ...(reasoningText ? { reasoning_text: reasoningText } : {}),
                ...(reasoningOpaque === undefined ? {} : { reasoning_opaque: reasoningOpaque }),
              },
            },
          },
        };
      }
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
      if (thinkingStarted && !thinkingEnded) {
        yield {
          type: 'thinking_end',
          blockId: 'thinking-0',
          completion: { status: 'partial', text: reasoningText },
        };
      }
      yield {
        type: 'error',
        error: normalizeError(error, request, request.outputTokenLimit),
      };
    }
  }

  chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    return collectChat(this.chatStream(request));
  }
}

function buildRequest(
  request: ModelInvocationRequest,
  connectionId: string,
  supportsThinkingSwitch: boolean,
): Record<string, unknown> {
  if (request.reasoning?.thinking !== undefined && !supportsThinkingSwitch) {
    throw createInvalidRequestError(
      request,
      'OpenAI Chat Completions has no adapter for the requested Thinking switch.',
    );
  }
  const reasoningEffort = request.reasoning?.thinking === 'off'
    ? 'none'
    : request.reasoning?.effort === 'default'
      ? undefined
      : request.reasoning?.effort;
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.outputTokenLimit === undefined
      ? {}
      : { max_tokens: request.outputTokenLimit }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    messages: [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...convertMessages(request.messages, connectionId),
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

function convertMessages(
  messages: readonly ChatMessage[],
  connectionId: string,
): unknown[] {
  const output: unknown[] = [];
  for (const message of messages) {
    const wireRole = message.origin === 'host' ? 'user' : message.role;
    if (typeof message.content === 'string') {
      output.push({ role: wireRole, content: message.content });
      continue;
    }
    let content: unknown[] = [];
    const toolCalls: unknown[] = [];
    let replay: Extract<ChatContentBlock, { type: 'thinking' }> | undefined;
    const flushContent = (): void => {
      if (!content.length) return;
      output.push({ role: wireRole, content });
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
      } else if (block.type === 'tool_result') {
        flushContent();
        output.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
      } else if (block.type === 'execution_accepted') {
        flushContent();
        output.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: renderExecutionAcceptedReceipt({
            executionId: block.execution_id,
            status: 'accepted',
          }),
        });
      } else {
        if (message.role !== 'assistant') {
          throw new Error('OpenAI Chat Completions cannot project Thinking on a user message.');
        }
        if (block.status === 'partial') continue;
        if (message.invocation?.source.wireProtocol !== 'openai-chat-completions') continue;
        assertReplaySource(
          message,
          block.id,
          'builtin',
          connectionId,
          'openai-chat-completions',
        );
        if (replay) {
          throw new Error('OpenAI Chat Completions supports one replay block per assistant message.');
        }

        replay = block;
      }
    }
    if (toolCalls.length || replay) {
      const replayPayload = replay?.status === 'complete'
        ? readChatReplay(replay.replay)
        : undefined;
      output.push({
        role: 'assistant',
        content: content.length ? content : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(replayPayload?.reasoning_text !== undefined
          ? { reasoning_text: replayPayload.reasoning_text }
          : {}),
        ...(replayPayload?.reasoning_opaque !== undefined
          ? { reasoning_opaque: replayPayload.reasoning_opaque }
          : {}),
      });
      content = [];
    }

    flushContent();
  }
  return output;
}

function assertReplaySource(
  message: ChatMessage,
  thinkingId: string,
  providerId: string,
  connectionId: string,
  wireProtocol: 'openai-chat-completions',
): void {
  const invocation = message.invocation;
  if (
    !invocation
    || !thinkingId.startsWith(`${invocation.id}:`)
    || invocation.source.providerId !== providerId
    || invocation.source.connectionId !== connectionId
    || invocation.source.wireProtocol !== wireProtocol
  ) {
    throw new Error('OpenAI Chat Completions replay source is unsupported.');
  }
}

function readChatReplay(
  replay: ProviderReplayState,
): { reasoning_text?: string; reasoning_opaque?: string } {
  if (replay.format !== CHAT_REASONING_REPLAY_FORMAT) {
    throw new Error('OpenAI Chat Completions received unsupported replay state.');
  }
  const reasoningText = replay.payload.reasoning_text;
  const reasoningOpaque = replay.payload.reasoning_opaque;
  if (reasoningText !== undefined && typeof reasoningText !== 'string') {
    throw new Error('OpenAI Chat Completions replay reasoning_text is invalid.');
  }
  if (reasoningOpaque !== undefined && typeof reasoningOpaque !== 'string') {
    throw new Error('OpenAI Chat Completions replay reasoning_opaque is invalid.');
  }
  if (!reasoningText && !reasoningOpaque) {
    throw new Error('OpenAI Chat Completions replay state is empty.');
  }
  return {
    ...(reasoningText === undefined ? {} : { reasoning_text: reasoningText }),
    ...(reasoningOpaque === undefined ? {} : { reasoning_opaque: reasoningOpaque }),
  };
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
