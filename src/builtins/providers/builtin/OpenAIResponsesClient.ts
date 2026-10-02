import { randomUUID } from 'crypto';
import type {
  ChatMessage,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
  ProviderReplayState,
  ReplayJsonValue,
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
  type Terminal,
} from './client-common.js';

export type OpenAIResponsesClientOptions = ProtocolClientOptions & {
  readonly readableSummaryModels?: readonly string[];
};

const RESPONSES_REASONING_REPLAY_FORMAT = 'openai-responses.reasoning-item.v1';

interface ResponsesReasoningItem {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  content?: { type: 'reasoning_text'; text: string }[];
  encrypted_content?: string | null;
  status?: 'completed';
}

export class OpenAIResponsesClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIResponsesClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const invocationId = request.invocationId ?? randomUUID();
    const reasoning = new Map<string, {
      blockId: string;
      summaries: Map<number, string>;
      ended: boolean;
    }>();
    const reasoningByOutputIndex = new Map<number, {
      blockId: string;
      summaries: Map<number, string>;
      ended: boolean;
    }>();
    try {
      const apiKey = this.options.apiKey?.trim();
      const response = await this.fetchImpl(`${this.options.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildRequest(
          request,
          this.options.baseURL,
          this.options.readableSummaryModels?.includes(request.model) === true,
        )),
        signal: request.signal,
      });
      if (!response.ok) {
        throw await createHttpError(response, request, request.outputTokenLimit);
      }
      if (!response.body) throw new Error('OpenAI Responses streaming response has no body.');

      let started = false;
      let terminal: Terminal | undefined;
      let done = false;
      const seenCallIds = new Set<string>();
      for await (const data of readSseData(response.body, request.signal)) {
        if (data === '[DONE]') {
          if (!terminal || done) throw new Error('OpenAI Responses sent an invalid [DONE] marker.');
          done = true;
          continue;
        }
        if (done) throw new Error('OpenAI Responses sent an event after [DONE].');
        const event = parseRecord(data, 'OpenAI Responses sent malformed SSE JSON.');
        const type = readNonEmptyString(event.type, 'OpenAI Responses event type');
        if (!started && isOutputEvent(type)) {
          throw new Error(`OpenAI Responses sent "${type}" before response.created.`);
        }
        if (terminal) throw new Error('OpenAI Responses sent an event after its terminal event.');
        switch (type) {
          case 'response.created':
            if (started) throw new Error('OpenAI Responses sent duplicate response.created events.');
            started = true;
            {
              const response = asRecord(event.response);
              const responseModelId = readString(response?.model);
              yield {
                type: 'message_start',
                invocation: {
                  id: invocationId,
                  source: {
                    providerId: 'builtin',
                    connectionId: this.options.baseURL,
                    requestModelId: request.model,
                    wireProtocol: 'openai-responses',
                    ...(responseModelId === undefined ? {} : { responseModelId }),
                  },
                },
              };
            }
            break;
          case 'response.output_item.added': {
            const item = asRecord(event.item);
            if (item?.type !== 'reasoning') break;
            const itemId = readNonEmptyString(item.id, 'OpenAI Responses reasoning item id');
            if (reasoning.has(itemId)) {
              throw new Error('OpenAI Responses sent a duplicate reasoning item id.');
            }
            const outputIndex = readNonNegativeInteger(
              event.output_index,
              'OpenAI Responses reasoning output_index',
            );
            if (reasoningByOutputIndex.has(outputIndex)) {
              throw new Error('OpenAI Responses sent a duplicate reasoning output_index.');
            }
            const blockId = `thinking-${outputIndex}`;
            const pending = { blockId, summaries: new Map<number, string>(), ended: false };
            reasoning.set(itemId, pending);
            reasoningByOutputIndex.set(outputIndex, pending);
            yield { type: 'thinking_start', blockId };
            break;
          }
          case 'response.reasoning_summary_text.delta': {
            const itemId = readNonEmptyString(
              event.item_id,
              'OpenAI Responses reasoning summary item_id',
            );
            const outputIndex = event.output_index === undefined
              ? undefined
              : readNonNegativeInteger(
                  event.output_index,
                  'OpenAI Responses reasoning output_index',
                );
            const pendingById = reasoning.get(itemId);
            const pendingByIndex = outputIndex === undefined
              ? undefined
              : reasoningByOutputIndex.get(outputIndex);
            if (pendingById && pendingByIndex && pendingById !== pendingByIndex) {
              throw new Error('OpenAI Responses reasoning summary correlation is ambiguous.');
            }
            const pending = pendingById ?? pendingByIndex;
            if (!pending || pending.ended) {
              throw new Error('OpenAI Responses referenced an unknown reasoning item.');
            }
            const summaryIndex = readNonNegativeInteger(
              event.summary_index,
              'OpenAI Responses reasoning summary_index',
            );
            const delta = readString(event.delta);
            if (delta === undefined) {
              throw new Error('OpenAI Responses reasoning summary delta is invalid.');
            }
            pending.summaries.set(
              summaryIndex,
              (pending.summaries.get(summaryIndex) ?? '') + delta,
            );
            yield { type: 'thinking_delta', blockId: pending.blockId, text: delta };
            break;
          }
          case 'response.output_text.delta': {
            const text = readString(event.delta);
            if (text === undefined) throw new Error('OpenAI Responses text delta is invalid.');
            yield { type: 'text_delta', text };
            break;
          }
          case 'response.output_item.done': {
            const item = asRecord(event.item);
            if (item?.type === 'reasoning') {
              const itemId = readNonEmptyString(item.id, 'OpenAI Responses reasoning item id');
              const outputIndex = event.output_index === undefined
                ? undefined
                : readNonNegativeInteger(
                    event.output_index,
                    'OpenAI Responses reasoning output_index',
                  );
              const pendingById = reasoning.get(itemId);
              const pendingByIndex = outputIndex === undefined
                ? undefined
                : reasoningByOutputIndex.get(outputIndex);
              if (pendingById && pendingByIndex && pendingById !== pendingByIndex) {
                throw new Error('OpenAI Responses reasoning item correlation is ambiguous.');
              }
              const pending = pendingById ?? pendingByIndex;
              if (!pending || pending.ended) {
                throw new Error('OpenAI Responses completed an unknown reasoning item.');
              }
              const parsed = parseReasoningItem(item);
              pending.ended = true;
              yield {
                type: 'thinking_end',
                blockId: pending.blockId,
                completion: parsed.complete
                  ? {
                      status: 'complete',
                      text: projectSummary(parsed.summary),
                      replay: {
                        format: RESPONSES_REASONING_REPLAY_FORMAT,
                        payload: { item: reasoningItemToPayload(parsed.item) },
                      },
                    }
                  : {
                      status: 'partial',
                      text: projectSummary(parsed.summary),
                    },
              };
              break;
            }
            if (item?.type !== 'function_call') break;
            const callId = readNonEmptyString(item.call_id, 'OpenAI Responses Tool Call call_id');
            const name = readNonEmptyString(item.name, 'OpenAI Responses Tool Call name');
            if (seenCallIds.has(callId)) {
              throw new Error(`OpenAI Responses sent duplicate Tool Call id "${callId}".`);
            }
            seenCallIds.add(callId);
            const call: ToolCall = Object.freeze({
              callId,
              name,
              input: parseToolInput(item.arguments),
            });
            yield { type: 'tool_call', call };
            break;
          }
          case 'response.completed':
            terminal = terminalFromResponse(event.response, seenCallIds.size, false);
            break;
          case 'response.incomplete':
            terminal = terminalFromResponse(event.response, seenCallIds.size, true);
            break;
          case 'response.failed':
          case 'error':
            throw createStreamError(event, request, request.outputTokenLimit);
          default:
            if (/^response\.[^.]+$/u.test(type)
              && type !== 'response.queued'
              && type !== 'response.in_progress') {
              throw new Error(`OpenAI Responses sent unsupported response state "${type}".`);
            }
        }
      }
      if (!started) throw new Error('OpenAI Responses stream ended before response.created.');
      if (!terminal) throw new Error('OpenAI Responses stream ended before a terminal event.');
      for (const pending of reasoning.values()) {
        if (!pending.ended) {
          throw new Error('OpenAI Responses left a reasoning item incomplete.');
        }
      }
      yield { type: 'message_end', ...terminal };
    } catch (error) {
      for (const pending of reasoning.values()) {
        if (pending.ended) continue;
        pending.ended = true;
        yield {
          type: 'thinking_end',
          blockId: pending.blockId,
          completion: {
            status: 'partial',
            text: projectSummary([...pending.summaries]
              .sort(([left], [right]) => left - right)
              .map(([, text]) => ({ type: 'summary_text' as const, text }))),
          },
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
  readableSummary: boolean,
): Record<string, unknown> {
  const reasoning = buildReasoningRequest(request, readableSummary);
  return {
    model: request.model,
    stream: true,
    ...(request.outputTokenLimit === undefined
      ? {}
      : { max_output_tokens: request.outputTokenLimit }),
    ...(request.system ? { instructions: request.system } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    input: convertMessages(request.messages, connectionId),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }
      : {}),
  };
}

function buildReasoningRequest(
  request: ModelInvocationRequest,
  readableSummary: boolean,
): Record<string, string> | undefined {
  const policy = request.reasoning;
  if (!policy) return undefined;
  if (policy.thinking === 'off') {
    throw createInvalidRequestError(
      request,
      'OpenAI Responses does not support the requested Thinking switch.',
    );
  }
  if (policy.thinking === 'on' && !readableSummary) {
    throw createInvalidRequestError(
      request,
      'OpenAI Responses has no adapter for the requested Thinking switch.',
    );
  }
  const explicitEffort = policy.effort === 'default' ? undefined : policy.effort;
  const requestSummary = readableSummary
    && (
      policy.thinking === 'on'
      || (explicitEffort !== undefined && explicitEffort !== 'none')
    );
  if (explicitEffort === undefined && !requestSummary) return undefined;
  return {
    ...(explicitEffort === undefined ? {} : { effort: explicitEffort }),
    ...(requestSummary ? { summary: 'auto' } : {}),
  };
}

function convertMessages(
  messages: readonly ChatMessage[],
  connectionId: string,
): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    const wireRole = message.origin === 'host' ? 'user' : message.role;
    if (typeof message.content === 'string') {
      input.push({
        role: wireRole,
        content: [{
          type: wireRole === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        }],
      });
      continue;
    }
    let pending: unknown[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      input.push({ role: wireRole, content: pending });
      pending = [];
    };
    for (const block of message.content) {
      if (block.type === 'text') {
        pending.push({
          type: wireRole === 'assistant' ? 'output_text' : 'input_text',
          text: block.text,
        });
      } else if (block.type === 'image') {
        pending.push({
          type: 'input_image',
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        });
      } else if (block.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        flush();
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      } else if (block.type === 'execution_accepted') {
        flush();
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: renderExecutionAcceptedReceipt({
            executionId: block.execution_id,
            status: 'accepted',
          }),
        });
      } else {
        if (message.role !== 'assistant') {
          throw new Error('OpenAI Responses cannot project Thinking on a user message.');
        }
        if (block.status === 'partial') continue;
        if (message.invocation?.source.wireProtocol !== 'openai-responses') continue;
        assertReplaySource(
          message,
          block.id,
          'builtin',
          connectionId,
          'openai-responses',
        );
        flush();
        input.push(readResponsesReplay(block.replay));
      }

    }
    flush();
  }
  return input;
}

function assertReplaySource(
  message: ChatMessage,
  thinkingId: string,
  providerId: string,
  connectionId: string,
  wireProtocol: 'openai-responses',
): void {
  const invocation = message.invocation;
  if (
    !invocation
    || !thinkingId.startsWith(`${invocation.id}:`)
    || invocation.source.providerId !== providerId
    || invocation.source.connectionId !== connectionId
    || invocation.source.wireProtocol !== wireProtocol
  ) {
    throw new Error('OpenAI Responses replay source is unsupported.');
  }
}

function parseReasoningItem(value: Record<string, unknown>): {
  readonly complete: boolean;
  readonly item: ResponsesReasoningItem;
  readonly summary: ResponsesReasoningItem['summary'];
} {
  const id = readNonEmptyString(value.id, 'OpenAI Responses reasoning item id');
  if (!Array.isArray(value.summary)) {
    throw new Error('OpenAI Responses reasoning summary is invalid.');
  }
  const summary = value.summary.map((raw, index) => {
    const part = asRecord(raw);
    if (part?.type !== 'summary_text' || typeof part.text !== 'string') {
      throw new Error(`OpenAI Responses reasoning summary item ${index} is invalid.`);
    }
    return { type: 'summary_text' as const, text: part.text };
  });
  let content: ResponsesReasoningItem['content'];
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) {
      throw new Error('OpenAI Responses reasoning content is invalid.');
    }
    content = value.content.map((raw, index) => {
      const part = asRecord(raw);
      if (part?.type !== 'reasoning_text' || typeof part.text !== 'string') {
        throw new Error(`OpenAI Responses reasoning content item ${index} is invalid.`);
      }
      return { type: 'reasoning_text' as const, text: part.text };
    });
  }
  let encryptedContent: string | null | undefined;
  if (Object.hasOwn(value, 'encrypted_content')) {
    if (value.encrypted_content !== null && typeof value.encrypted_content !== 'string') {
      throw new Error('OpenAI Responses reasoning encrypted_content is invalid.');
    }
    encryptedContent = value.encrypted_content;
  }
  const status = value.status;
  if (
    status !== undefined
    && status !== 'completed'
    && status !== 'in_progress'
    && status !== 'incomplete'
  ) {
    throw new Error('OpenAI Responses reasoning status is invalid.');
  }
  const item: ResponsesReasoningItem = {
    type: 'reasoning',
    id,
    summary,
    ...(content === undefined ? {} : { content }),
    ...(Object.hasOwn(value, 'encrypted_content')
      ? { encrypted_content: encryptedContent }
      : {}),
    ...(status === 'completed' ? { status } : {}),
  };
  return {
    complete: status === undefined || status === 'completed',
    item,
    summary,
  };
}

function readResponsesReplay(replay: ProviderReplayState): ResponsesReasoningItem {
  if (replay.format !== RESPONSES_REASONING_REPLAY_FORMAT) {
    throw new Error('OpenAI Responses received unsupported replay state.');
  }
  const item = asRecord(replay.payload.item);
  if (!item) throw new Error('OpenAI Responses replay item is invalid.');
  const parsed = parseReasoningItem(item);
  if (!parsed.complete) throw new Error('OpenAI Responses replay item is incomplete.');
  return parsed.item;
}

function reasoningItemToPayload(
  item: ResponsesReasoningItem,
): { [key: string]: ReplayJsonValue } {
  return {
    type: 'reasoning',
    id: item.id,
    summary: item.summary.map((part) => ({ type: part.type, text: part.text })),
    ...(item.content === undefined
      ? {}
      : {
          content: item.content.map((part) => ({ type: part.type, text: part.text })),
        }),
    ...(Object.hasOwn(item, 'encrypted_content')
      ? { encrypted_content: item.encrypted_content ?? null }
      : {}),
    ...(item.status === undefined ? {} : { status: item.status }),
  };
}

function projectSummary(summary: ResponsesReasoningItem['summary']): string {
  return summary.map((part) => part.text).join('\n\n');
}

function terminalFromResponse(value: unknown, toolCalls: number, incomplete: boolean): Terminal {
  const response = asRecord(value);
  if (!response) throw new Error('OpenAI Responses terminal response is invalid.');
  let stopReason = toolCalls ? 'tool_use' : 'end_turn';
  if (incomplete) {
    if (asRecord(response.incomplete_details)?.reason !== 'max_output_tokens') {
      throw new Error('OpenAI Responses returned an unsupported incomplete reason.');
    }
    stopReason = 'max_tokens';
  }
  const usage = asRecord(response.usage);
  return Object.freeze({
    stopReason,
    usage: Object.freeze({
      inputTokens: readNonNegativeInteger(
        usage?.input_tokens,
        'OpenAI Responses usage.input_tokens',
      ),
      outputTokens: readNonNegativeInteger(
        usage?.output_tokens,
        'OpenAI Responses usage.output_tokens',
      ),
    }),
  });
}

function isOutputEvent(type: string): boolean {
  return type.startsWith('response.output_')
    || type.startsWith('response.content_part.')
    || type.startsWith('response.function_call_arguments.');
}
