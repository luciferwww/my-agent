import { randomUUID } from 'crypto';
import type {
  ChatMessage,
  ModelInvocationDiagnostics,
  ModelInvocationFailureCategory,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelInvocationStructuralErrorV1,
  ModelStreamEvent,
  ProviderReplayState,
  ReplayJsonValue,
  TokenUsage,
  ToolCall,
} from 'my-agent/extension-api';
import { ModelStreamCollector } from 'my-agent/extension-api';

export const COPILOT_PROVIDER_ID = 'copilot-login-experiment';
export const OPENAI_RESPONSES_PROTOCOL = 'openai-responses';
const RESPONSES_REASONING_REPLAY_FORMAT = 'openai-responses.reasoning-item.v1';

interface ResponsesReasoningItem {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  content?: { type: 'reasoning_text'; text: string }[];
  encrypted_content?: string | null;
  status?: 'completed';
}

interface ResponsesClientOptions {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

interface PendingTerminal {
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  readonly usage: TokenUsage;
}

interface CopilotInvocationDiagnostics extends ModelInvocationDiagnostics {
  readonly providerId: typeof COPILOT_PROVIDER_ID;
}

export class CopilotInvocationError extends Error implements ModelInvocationStructuralErrorV1 {
  readonly protocol = 'my-agent.model-invocation-error';
  readonly version = 1 as const;
  readonly diagnostics: CopilotInvocationDiagnostics;

  constructor(
    readonly category: ModelInvocationFailureCategory,
    diagnostics: CopilotInvocationDiagnostics,
  ) {
    super(`Model invocation failed: ${category}.`);
    this.name = 'ModelInvocationError';
    this.diagnostics = Object.freeze({
      ...diagnostics,
      request: Object.freeze({ ...diagnostics.request }),
    });
  }
}

export class CopilotResponsesClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization?: string;

  constructor(private readonly options: ResponsesClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const apiKey = options.apiKey?.trim();
    this.authorization = apiKey ? `Bearer ${apiKey}` : undefined;
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
      const response = await this.fetchImpl(`${this.options.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify(buildResponsesRequest(request, this.options.baseURL)),
        signal: request.signal,
      });
      if (!response.ok) throw await createHttpError(response, request);
      if (!response.body) throw new Error('GitHub Copilot streaming response has no body.');

      let started = false;
      let pendingTerminal: PendingTerminal | undefined;
      let sawDone = false;
      const seenCallIds = new Set<string>();
      for await (const data of readSseData(response.body, request.signal)) {
        if (data === '[DONE]') {
          if (!pendingTerminal) throw new Error('GitHub Copilot sent [DONE] before a terminal event.');
          if (sawDone) throw new Error('GitHub Copilot sent duplicate [DONE] markers.');
          sawDone = true;
          continue;
        }
        if (sawDone) throw new Error('GitHub Copilot sent an event after [DONE].');

        const event = parseJsonRecord(data, 'GitHub Copilot sent malformed SSE JSON.');
        const type = readString(event.type);
        if (!type) throw new Error('GitHub Copilot SSE event type is missing.');
        if (!started && isOutputEventType(type)) {
          throw new Error(`GitHub Copilot sent "${type}" before response.created.`);
        }
        if (pendingTerminal) {
          if (isTerminalType(type)) {
            throw new Error('GitHub Copilot sent duplicate terminal events.');
          }
          throw new Error(`GitHub Copilot sent "${type}" after its terminal event.`);
        }

        switch (type) {
          case 'response.created':
            if (started) throw new Error('GitHub Copilot sent duplicate response.created events.');
            started = true;
            {
              const created = asRecord(event.response);
              const responseModelId = readString(created?.model);
              yield {
                type: 'message_start',
                invocation: {
                  id: invocationId,
                  source: {
                    providerId: COPILOT_PROVIDER_ID,
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
            const itemId = readNonEmptyString(item.id, 'GitHub Copilot reasoning item id');
            if (reasoning.has(itemId)) {
              throw new Error('GitHub Copilot sent a duplicate reasoning item id.');
            }
            const outputIndex = readNonNegativeInteger(
              event.output_index,
              'GitHub Copilot reasoning output_index',
            );
            if (reasoningByOutputIndex.has(outputIndex)) {
              throw new Error('GitHub Copilot sent a duplicate reasoning output_index.');
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
              'GitHub Copilot reasoning summary item_id',
            );
            const pending = reasoning.get(itemId);
            if (!pending || pending.ended) {
              throw new Error('GitHub Copilot referenced an unknown reasoning item.');
            }
            const summaryIndex = readNonNegativeInteger(
              event.summary_index,
              'GitHub Copilot reasoning summary_index',
            );
            const delta = readString(event.delta);
            if (delta === undefined) {
              throw new Error('GitHub Copilot reasoning summary delta is invalid.');
            }
            pending.summaries.set(
              summaryIndex,
              (pending.summaries.get(summaryIndex) ?? '') + delta,
            );
            yield { type: 'thinking_delta', blockId: pending.blockId, text: delta };
            break;
          }
          case 'response.output_text.delta': {
            if (!started) throw new Error('GitHub Copilot sent text before response.created.');
            const text = readString(event.delta);
            if (text === undefined) throw new Error('GitHub Copilot text delta is invalid.');
            yield { type: 'text_delta', text };
            break;
          }
          case 'response.output_item.done': {
            const item = asRecord(event.item);
            if (item?.type === 'reasoning') {
              const itemId = readNonEmptyString(item.id, 'GitHub Copilot reasoning item id');
              const outputIndex = event.output_index === undefined
                ? undefined
                : readNonNegativeInteger(
                    event.output_index,
                    'GitHub Copilot reasoning output_index',
                  );
              const pendingById = reasoning.get(itemId);
              const pendingByIndex = outputIndex === undefined
                ? undefined
                : reasoningByOutputIndex.get(outputIndex);
              if (pendingById && pendingByIndex && pendingById !== pendingByIndex) {
                throw new Error('GitHub Copilot reasoning item correlation is ambiguous.');
              }
              const pending = pendingById ?? pendingByIndex;
              if (!pending || pending.ended) {
                throw new Error('GitHub Copilot completed an unknown reasoning item.');
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
                  : { status: 'partial', text: projectSummary(parsed.summary) },
              };
              break;
            }
            if (item?.type !== 'function_call') break;
            const call = parseToolCall(item, seenCallIds);
            yield { type: 'tool_call', call };
            break;
          }
          case 'response.completed':
            pendingTerminal = terminalFromResponse(event.response, seenCallIds.size, false);
            break;
          case 'response.incomplete':
            pendingTerminal = terminalFromResponse(event.response, seenCallIds.size, true);
            break;
          case 'response.failed':
          case 'error':
            throw createStreamError(
              asRecord(event.response)?.error ?? event.error ?? event,
              request,
            );
          default:
            if (isUnknownResponseState(type)) {
              throw new Error(`GitHub Copilot sent unsupported response state "${type}".`);
            }
            break;
        }
      }
      if (!started) throw new Error('GitHub Copilot stream ended before response.created.');
      if (!pendingTerminal) throw new Error('GitHub Copilot stream ended before a terminal event.');
      for (const pending of reasoning.values()) {
        if (!pending.ended) {
          throw new Error('GitHub Copilot left a reasoning item incomplete.');
        }
      }
      yield { type: 'message_end', ...pendingTerminal };
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
        error: normalizeError(error, request),
      };
    }
  }

  async chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const collector = new ModelStreamCollector();
    for await (const event of this.chatStream(request)) {
      collector.push(event);
    }
    return collector.finish();
  }
}

function buildResponsesRequest(
  request: ModelInvocationRequest,
  connectionId: string,
): Record<string, unknown> {
  if (request.reasoning?.thinking !== undefined) {
    throw createCopilotInvalidRequestError(
      request,
      'GitHub Copilot Responses does not support the requested Thinking switch.',
    );
  }
  const reasoningEffort = request.reasoning?.effort === 'default'
    ? undefined
    : request.reasoning?.effort;
  return {
    model: request.model,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(request.outputTokenLimit === undefined ? {} : { max_output_tokens: request.outputTokenLimit }),
    ...(request.system ? { instructions: request.system } : {}),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: reasoningEffort } }),
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

function convertMessages(
  messages: readonly ChatMessage[],
  connectionId: string,
): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    const role = message.origin === 'host' ? 'user' : message.role;
    if (typeof message.content === 'string') {
      input.push(messageItem(role, [{
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      }]));
      continue;
    }

    let pendingContent: unknown[] = [];
    const flush = (): void => {
      if (pendingContent.length === 0) return;
      input.push(messageItem(role, pendingContent));
      pendingContent = [];
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          pendingContent.push({
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: block.text,
          });
          break;
        case 'image':
          pendingContent.push({
            type: 'input_image',
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          });
          break;
        case 'tool_use':
          flush();
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case 'tool_result':
          flush();
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: block.content,
          });
          break;
        case 'execution_accepted':
          flush();
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: JSON.stringify({
              status: 'accepted',
              executionId: block.execution_id,
            }),
          });
          break;
        case 'thinking':
          if (message.role !== 'assistant') {
            throw new Error('GitHub Copilot cannot project Thinking on a user message.');
          }
          if (block.status === 'partial') break;
          assertReplaySource(message, block.id, connectionId);
          flush();
          input.push(readResponsesReplay(block.replay));
          break;
      }

    }
    flush();
  }
  return input;
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
    || invocation.source.providerId !== COPILOT_PROVIDER_ID
    || invocation.source.connectionId !== connectionId
    || invocation.source.wireProtocol !== OPENAI_RESPONSES_PROTOCOL
  ) {
    throw new Error('GitHub Copilot replay source is unsupported.');
  }
}

function parseReasoningItem(value: Record<string, unknown>): {
  readonly complete: boolean;
  readonly item: ResponsesReasoningItem;
  readonly summary: ResponsesReasoningItem['summary'];
} {
  const id = readNonEmptyString(value.id, 'GitHub Copilot reasoning item id');
  if (!Array.isArray(value.summary)) throw new Error('GitHub Copilot reasoning summary is invalid.');
  const summary = value.summary.map((raw, index) => {
    const part = asRecord(raw);
    if (part?.type !== 'summary_text' || typeof part.text !== 'string') {
      throw new Error(`GitHub Copilot reasoning summary item ${index} is invalid.`);
    }
    return { type: 'summary_text' as const, text: part.text };
  });
  let content: ResponsesReasoningItem['content'];
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) throw new Error('GitHub Copilot reasoning content is invalid.');
    content = value.content.map((raw, index) => {
      const part = asRecord(raw);
      if (part?.type !== 'reasoning_text' || typeof part.text !== 'string') {
        throw new Error(`GitHub Copilot reasoning content item ${index} is invalid.`);
      }
      return { type: 'reasoning_text' as const, text: part.text };
    });
  }
  let encryptedContent: string | null | undefined;
  if (Object.hasOwn(value, 'encrypted_content')) {
    if (value.encrypted_content !== null && typeof value.encrypted_content !== 'string') {
      throw new Error('GitHub Copilot reasoning encrypted_content is invalid.');
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
    throw new Error('GitHub Copilot reasoning status is invalid.');
  }
  return {
    complete: status === undefined || status === 'completed',
    summary,
    item: {
      type: 'reasoning',
      id,
      summary,
      ...(content === undefined ? {} : { content }),
      ...(Object.hasOwn(value, 'encrypted_content')
        ? { encrypted_content: encryptedContent }
        : {}),
      ...(status === 'completed' ? { status } : {}),
    },
  };
}

function readResponsesReplay(replay: ProviderReplayState): ResponsesReasoningItem {
  if (replay.format !== RESPONSES_REASONING_REPLAY_FORMAT) {
    throw new Error('GitHub Copilot received unsupported replay state.');
  }
  const item = asRecord(replay.payload.item);
  if (!item) throw new Error('GitHub Copilot replay item is invalid.');
  const parsed = parseReasoningItem(item);
  if (!parsed.complete) throw new Error('GitHub Copilot replay item is incomplete.');
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

function messageItem(role: ChatMessage['role'], content: unknown[]): Record<string, unknown> {
  return { role, content };
}

export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const result = await readWithSignal(reader, signal);
      if (result.done) {
        completed = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const boundary = findEventBoundary(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        if (block.length > 1024 * 1024) throw new Error('Copilot SSE event exceeds one MiB.');
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = parseSseBlock(block);
        if (data !== undefined) yield data;
      }
      if (buffer.length > 1024 * 1024) throw new Error('Copilot SSE event exceeds one MiB.');
    }
    if (buffer.trim()) {
      if (buffer.length > 1024 * 1024) throw new Error('Copilot SSE event exceeds one MiB.');
      const data = parseSseBlock(buffer);
      if (data !== undefined) yield data;
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/u.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseSseBlock(block: string): string | undefined {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
  }
  return data.length ? data.join('\n') : undefined;
}

function parseToolCall(item: Record<string, unknown>, seen: Set<string>): ToolCall {
  const callId = readNonEmptyString(item.call_id, 'Tool Call call_id');
  const name = readNonEmptyString(item.name, 'Tool Call name');
  if (seen.has(callId)) throw new Error(`GitHub Copilot sent duplicate Tool Call id "${callId}".`);
  seen.add(callId);

  let input: ToolCall['input'];
  try {
    const parsed: unknown = JSON.parse(readString(item.arguments) ?? '');
    const parsedRecord = asRecord(parsed);
    input = parsedRecord
      ? Object.freeze({ state: 'ready', value: Object.freeze({ ...parsedRecord }) })
      : Object.freeze({ state: 'invalid', reason: 'not_an_object' });
  } catch {
    input = Object.freeze({ state: 'invalid', reason: 'malformed_json' });
  }
  return Object.freeze({ callId, name, input });
}

function terminalFromResponse(
  value: unknown,
  toolCallCount: number,
  incomplete: boolean,
): PendingTerminal {
  const response = asRecord(value);
  if (!response) throw new Error('GitHub Copilot terminal response is invalid.');
  let stopReason: PendingTerminal['stopReason'];
  if (incomplete) {
    const details = asRecord(response.incomplete_details);
    if (details?.reason !== 'max_output_tokens') {
      throw new Error('GitHub Copilot returned an unsupported incomplete reason.');
    }
    stopReason = 'max_tokens';
  } else {
    stopReason = toolCallCount > 0 ? 'tool_use' : 'end_turn';
  }
  const usage = asRecord(response.usage);
  const inputTokens = readNonNegativeInteger(usage?.input_tokens, 'usage.input_tokens');
  const outputTokens = readNonNegativeInteger(usage?.output_tokens, 'usage.output_tokens');
  return Object.freeze({
    stopReason,
    usage: Object.freeze({ inputTokens, outputTokens }),
  });
}

export async function createHttpError(
  response: Response,
  request: ModelInvocationRequest,
): Promise<CopilotInvocationError> {
  const body = await readBoundedText(response, 64 * 1024, request.signal);
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(JSON.parse(body));
  } catch {
    payload = undefined;
  }
  const nested = asRecord(payload?.error);
  const diagnostics = invocationDiagnostics(request, {
    httpStatus: response.status,
    providerErrorType: sanitize(readString(nested?.type) ?? readString(payload?.type)),
    providerErrorCode: sanitize(readString(nested?.code)),
    providerMessage: `Copilot request failed (HTTP ${response.status}).`,
    requestId: sanitize(
      response.headers.get('x-request-id')
        ?? response.headers.get('x-github-request-id')
        ?? readString(payload?.request_id),
    ),
  });
  const category = response.status === 401 || response.status === 403
    ? 'authentication'
    : response.status === 429
      ? 'rate_limit'
    : response.status < 500 && diagnostics.providerErrorCode === 'model_not_found'
      ? 'model_not_found'
      : [400, 404, 409, 422].includes(response.status)
        ? 'invalid_request'
        : response.status >= 500
          ? 'unavailable'
          : 'provider_failure';
  return new CopilotInvocationError(category, diagnostics);
}

export function createStreamError(payload: unknown, request: ModelInvocationRequest): Error {
  const error = asRecord(payload);
  const code = sanitize(readString(error?.code));
  return new CopilotInvocationError(
    code === 'model_not_found' ? 'model_not_found' : 'provider_failure',
    invocationDiagnostics(request, {
      providerErrorCode: code,
      providerErrorType: sanitize(readString(error?.type)),
      providerMessage: 'Copilot reported an unsuccessful stream.',
    }),
  );
}

export function normalizeError(error: unknown, request: ModelInvocationRequest): Error {
  if (error instanceof CopilotInvocationError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new CopilotInvocationError(
    error instanceof TypeError ? 'transport' : 'provider_failure',
    invocationDiagnostics(request, {
      providerMessage: 'Copilot did not complete a valid invocation.',
    }),
  );
}

export function invocationDiagnostics(
  request: ModelInvocationRequest,
  provider: {
    httpStatus?: number;
    providerErrorType?: string;
    providerErrorCode?: string;
    providerMessage?: string;
    requestId?: string;
  },
): CopilotInvocationDiagnostics {
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let stringContentMessageCount = 0;
  let textBlockCount = 0;
  let imageBlockCount = 0;
  let toolUseBlockCount = 0;
  let toolResultBlockCount = 0;
  for (const message of request.messages) {
    if (message.role === 'user') userMessageCount += 1;
    else assistantMessageCount += 1;
    if (typeof message.content === 'string') {
      stringContentMessageCount += 1;
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') textBlockCount += 1;
      else if (block.type === 'image') imageBlockCount += 1;
      else if (block.type === 'tool_use') toolUseBlockCount += 1;
      else if (block.type === 'tool_result') toolResultBlockCount += 1;
    }
  }
  return {
    providerId: COPILOT_PROVIDER_ID,
    ...(provider.httpStatus === undefined ? {} : { httpStatus: provider.httpStatus }),
    ...(provider.providerErrorType === undefined
      ? {} : { providerErrorType: provider.providerErrorType }),
    ...(provider.providerErrorCode === undefined
      ? {} : { providerErrorCode: provider.providerErrorCode }),
    ...(provider.providerMessage === undefined
      ? {} : { providerMessage: provider.providerMessage }),
    ...(provider.requestId === undefined ? {} : { requestId: provider.requestId }),
    request: Object.freeze({
      model: request.model,
      hasSystem: Boolean(request.system),
      messageCount: request.messages.length,
      userMessageCount,
      assistantMessageCount,
      stringContentMessageCount,
      textBlockCount,
      imageBlockCount,
      toolUseBlockCount,
      toolResultBlockCount,
      toolDefinitionCount: request.tools?.length ?? 0,
    }),
  };
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= maximumBytes) {
      const result = await readWithSignal(reader, signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) break;
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function isTerminalType(type: string): boolean {
  return type === 'response.completed'
    || type === 'response.incomplete'
    || type === 'response.failed'
    || type === 'error';
}

function isOutputEventType(type: string): boolean {
  return type.startsWith('response.output_item.')
    || type.startsWith('response.content_part.')
    || type.startsWith('response.output_text.')
    || type.startsWith('response.function_call_arguments.');
}

function isUnknownResponseState(type: string): boolean {
  return /^response\.[^.]+$/u.test(type)
    && type !== 'response.queued'
    && type !== 'response.in_progress';
}

export function parseJsonRecord(value: string, message: string): Record<string, unknown> {
  try {
    const parsed = asRecord(JSON.parse(value));
    if (parsed) return parsed;
  } catch {
    // Replaced by the bounded protocol error below.
  }
  throw new Error(message);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readNonEmptyString(value: unknown, field: string): string {
  const result = readString(value)?.trim();
  if (!result) throw new Error(`GitHub Copilot ${field} is missing.`);
  return result;
}

export function readNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`GitHub Copilot ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function sanitize(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

export function createCopilotInvalidRequestError(
  request: ModelInvocationRequest,
  providerMessage: string,
): CopilotInvocationError {
  return new CopilotInvocationError(
    'invalid_request',
    invocationDiagnostics(request, {
      providerMessage: sanitize(providerMessage),
    }),
  );
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
