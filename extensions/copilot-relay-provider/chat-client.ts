import { randomUUID } from 'crypto';
import type {
  ChatContentBlock,
  ChatMessage,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
  ProviderReplayState,
  ToolCall,
} from 'my-agent/extension-api';
import { ModelStreamCollector } from 'my-agent/extension-api';
import {
  COPILOT_RELAY_PROVIDER_ID,
  asRecord,
  createHttpError,
  createRelayInvalidRequestError,
  normalizeError,
  parseJsonRecord,
  readNonNegativeInteger,
  readSseData,
  readString,
} from './responses-client.js';

export const OPENAI_CHAT_COMPLETIONS_PROTOCOL = 'openai-chat-completions';
const CHAT_REASONING_REPLAY_FORMAT = 'openai-chat-completions.reasoning.v1';

interface ChatClientOptions {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

interface PendingTool {
  id: string;
  name: string;
  arguments: string;
}

export class CopilotRelayChatCompletionsClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization?: string;

  constructor(private readonly options: ChatClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const apiKey = options.apiKey?.trim();
    this.authorization = apiKey ? ['Bearer', apiKey].join(' ') : undefined;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const invocationId = request.invocationId ?? randomUUID();
    let thinkingStarted = false;
    let thinkingEnded = false;
    let reasoningText = '';
    let reasoningOpaque: string | undefined;
    try {
      const response = await this.fetchImpl(
        `${this.options.baseURL}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(this.authorization ? { authorization: this.authorization } : {}),
          },
          body: JSON.stringify(buildChatRequest(request, this.options.baseURL)),
          signal: request.signal,
        },
      );
      if (!response.ok) throw await createHttpError(response, request);
      if (!response.body) throw new Error('Copilot Relay Chat streaming response has no body.');

      let started = false;
      let done = false;
      let finishReason: string | undefined;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      const tools = new Map<number, PendingTool>();
      for await (const data of readSseData(response.body, request.signal)) {
        if (data === '[DONE]') {
          if (done || !finishReason) {
            throw new Error('Copilot Relay Chat sent an invalid [DONE] marker.');
          }
          done = true;
          continue;
        }
        if (done) throw new Error('Copilot Relay Chat sent an event after [DONE].');
        const chunk = parseJsonRecord(data, 'Copilot Relay Chat sent malformed SSE JSON.');
        if (chunk.type === 'error' || chunk.error !== undefined) {
          throw new Error('Copilot Relay Chat returned a stream error.');
        }
        if (!started) {
          started = true;
          const responseModelId = readString(chunk.model);
          yield {
            type: 'message_start',
            invocation: {
              id: invocationId,
              source: {
                providerId: COPILOT_RELAY_PROVIDER_ID,
                connectionId: this.options.baseURL,
                requestModelId: request.model,
                wireProtocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL,
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
              'Copilot Relay Chat usage.prompt_tokens',
            ),
            outputTokens: readNonNegativeInteger(
              rawUsage.completion_tokens,
              'Copilot Relay Chat usage.completion_tokens',
            ),
          };
        }
        if (!Array.isArray(chunk.choices)) {
          throw new Error('Copilot Relay Chat choices are invalid.');
        }
        for (const rawChoice of chunk.choices) {
          const choice = asRecord(rawChoice);
          if (!choice) throw new Error('Copilot Relay Chat choice is invalid.');
          if (readNonNegativeInteger(
            choice.index,
            'Copilot Relay Chat choice.index',
          ) !== 0) {
            throw new Error('Copilot Relay Chat returned multiple choices.');
          }
          const delta = asRecord(choice.delta);
          if (!delta) throw new Error('Copilot Relay Chat choice delta is invalid.');
          const nextReasoningText = delta.reasoning_text;
          if (nextReasoningText !== undefined && nextReasoningText !== null) {
            if (typeof nextReasoningText !== 'string') {
              throw new Error('Copilot Relay Chat reasoning_text is invalid.');
            }
            if (nextReasoningText) {
              if (!thinkingStarted) {
                thinkingStarted = true;
                yield { type: 'thinking_start', blockId: 'thinking-0' };
              }
              reasoningText += nextReasoningText;
              yield {
                type: 'thinking_delta',
                blockId: 'thinking-0',
                text: nextReasoningText,
              };
            }
          }
          const nextOpaque = delta.reasoning_opaque;
          if (nextOpaque !== undefined && nextOpaque !== null) {
            if (typeof nextOpaque !== 'string') {
              throw new Error('Copilot Relay Chat reasoning_opaque is invalid.');
            }
            if (nextOpaque) {
              if (reasoningOpaque !== undefined) {
                throw new Error('Copilot Relay Chat sent multiple reasoning_opaque values.');
              }
              reasoningOpaque = nextOpaque;
              if (!thinkingStarted) {
                thinkingStarted = true;
                yield { type: 'thinking_start', blockId: 'thinking-0' };
              }
            }
          }
          const text = readString(delta.content);
          if (text !== undefined) yield { type: 'text_delta', text };
          appendToolDeltas(delta.tool_calls, tools);
          const nextFinishReason = readString(choice.finish_reason);
          if (nextFinishReason !== undefined) {
            if (finishReason !== undefined) {
              throw new Error('Copilot Relay Chat sent duplicate terminal choices.');
            }
            finishReason = nextFinishReason;
          }
        }
      }

      if (!started) throw new Error('Copilot Relay Chat stream ended before a response chunk.');
      if (!finishReason) throw new Error('Copilot Relay Chat stream ended before a terminal choice.');
      if (!usage) throw new Error('Copilot Relay Chat stream ended without usage.');
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
                ...(reasoningOpaque === undefined
                  ? {}
                  : { reasoning_opaque: reasoningOpaque }),
              },
            },
          },
        };
      }
      const seenCallIds = new Set<string>();
      for (const [, pending] of [...tools].sort(([left], [right]) => left - right)) {
        const callId = pending.id.trim();
        const name = pending.name.trim();
        if (!callId || !name) {
          throw new Error('Copilot Relay Chat Tool Call is incomplete.');
        }
        if (seenCallIds.has(callId)) {
          throw new Error(`Copilot Relay Chat sent duplicate Tool Call id "${callId}".`);
        }
        seenCallIds.add(callId);
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
      yield { type: 'error', error: normalizeError(error, request) };
    }
  }

  async chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const collector = new ModelStreamCollector();
    for await (const event of this.chatStream(request)) collector.push(event);
    return collector.finish();
  }
}

function buildChatRequest(
  request: ModelInvocationRequest,
  connectionId: string,
): Record<string, unknown> {
  if (request.reasoning?.thinking !== undefined) {
    throw createRelayInvalidRequestError(
      request,
      'Copilot Relay Chat does not support the requested Thinking switch.',
    );
  }
  const reasoningEffort = request.reasoning?.effort === 'default'
    ? undefined
    : request.reasoning?.effort;
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.outputTokenLimit === undefined
      ? {}
      : { max_tokens: request.outputTokenLimit }),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoning_effort: reasoningEffort }),
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
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === 'tool_result') {
        flushContent();
        output.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      } else if (block.type === 'thinking') {
        if (message.role !== 'assistant') {
          throw new Error('Copilot Relay Chat cannot project Thinking on a user message.');
        }
        if (block.status === 'partial') continue;
        if (message.invocation?.source.wireProtocol !== OPENAI_CHAT_COMPLETIONS_PROTOCOL) {
          continue;
        }
        assertReplaySource(message, block.id, connectionId);
        if (replay) {
          throw new Error('Copilot Relay Chat supports one replay block per assistant message.');
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
        ...(replayPayload?.reasoning_text === undefined
          ? {}
          : { reasoning_text: replayPayload.reasoning_text }),
        ...(replayPayload?.reasoning_opaque === undefined
          ? {}
          : { reasoning_opaque: replayPayload.reasoning_opaque }),
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
  connectionId: string,
): void {
  const invocation = message.invocation;
  if (
    !invocation
    || !thinkingId.startsWith(`${invocation.id}:`)
    || invocation.source.providerId !== COPILOT_RELAY_PROVIDER_ID
    || invocation.source.connectionId !== connectionId
    || invocation.source.wireProtocol !== OPENAI_CHAT_COMPLETIONS_PROTOCOL
  ) {
    throw new Error('Copilot Relay Chat replay source is unsupported.');
  }
}

function readChatReplay(
  replay: ProviderReplayState,
): { reasoning_text?: string; reasoning_opaque?: string } {
  if (replay.format !== CHAT_REASONING_REPLAY_FORMAT) {
    throw new Error('Copilot Relay Chat received unsupported replay state.');
  }
  const reasoningText = replay.payload.reasoning_text;
  const reasoningOpaque = replay.payload.reasoning_opaque;
  if (reasoningText !== undefined && typeof reasoningText !== 'string') {
    throw new Error('Copilot Relay Chat replay reasoning_text is invalid.');
  }
  if (reasoningOpaque !== undefined && typeof reasoningOpaque !== 'string') {
    throw new Error('Copilot Relay Chat replay reasoning_opaque is invalid.');
  }
  if (!reasoningText && !reasoningOpaque) {
    throw new Error('Copilot Relay Chat replay state is empty.');
  }
  return {
    ...(reasoningText === undefined ? {} : { reasoning_text: reasoningText }),
    ...(reasoningOpaque === undefined ? {} : { reasoning_opaque: reasoningOpaque }),
  };
}

function appendToolDeltas(value: unknown, tools: Map<number, PendingTool>): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Copilot Relay Chat Tool deltas are invalid.');
  }
  for (const raw of value) {
    const delta = asRecord(raw);
    if (!delta) throw new Error('Copilot Relay Chat Tool delta is invalid.');
    const index = readNonNegativeInteger(
      delta.index,
      'Copilot Relay Chat Tool delta index',
    );
    let pending = tools.get(index);
    if (!pending) {
      pending = { id: '', name: '', arguments: '' };
      tools.set(index, pending);
    }
    const id = readString(delta.id);
    if (id !== undefined) pending.id += id;
    const fn = asRecord(delta.function);
    const name = readString(fn?.name);
    if (name !== undefined) pending.name += name;
    const args = readString(fn?.arguments);
    if (args !== undefined) pending.arguments += args;
  }
}

function parseToolInput(value: string): ToolCall['input'] {
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = asRecord(parsed);
    return record
      ? Object.freeze({ state: 'ready', value: Object.freeze({ ...record }) })
      : Object.freeze({ state: 'invalid', reason: 'not_an_object' });
  } catch {
    return Object.freeze({ state: 'invalid', reason: 'malformed_json' });
  }
}

function normalizeStopReason(reason: string, toolCount: number): string {
  if (toolCount > 0 || reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_use';
  }
  if (reason === 'length') return 'max_tokens';
  return reason;
}
