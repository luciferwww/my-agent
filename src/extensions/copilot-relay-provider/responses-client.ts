import {
  ModelInvocationError,
  type ChatContentBlock,
  type ChatMessage,
  type ModelInvocationPort,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelStreamEvent,
  type TokenUsage,
} from '../../core/model-invocation/index.js';
import type { ToolCall } from '../../core/tools/index.js';

export const COPILOT_RELAY_PROVIDER_ID = 'copilot-relay';
export const OPENAI_RESPONSES_PROTOCOL = 'openai-responses';

interface ResponsesClientOptions {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

interface PendingTerminal {
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  readonly usage: TokenUsage;
}

interface RelayInvocationDiagnostics {
  readonly providerId: typeof COPILOT_RELAY_PROVIDER_ID;
  readonly httpStatus?: number;
  readonly providerErrorType?: string;
  readonly providerErrorCode?: string;
  readonly providerMessage?: string;
  readonly requestId?: string;
  readonly request: Readonly<{
    model: string;
    maxTokens: number;
    hasSystem: boolean;
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    stringContentMessageCount: number;
    textBlockCount: number;
    imageBlockCount: number;
    toolUseBlockCount: number;
    toolResultBlockCount: number;
    toolDefinitionCount: number;
  }>;
}

class CopilotRelayInvocationError extends ModelInvocationError {
  declare readonly diagnostics: RelayInvocationDiagnostics;

  constructor(
    category: ConstructorParameters<typeof ModelInvocationError>[0],
    diagnostics: RelayInvocationDiagnostics,
  ) {
    super(category);
    this.diagnostics = Object.freeze({
      ...diagnostics,
      request: Object.freeze({ ...diagnostics.request }),
    });
  }
}

export class CopilotRelayResponsesClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization?: string;

  constructor(private readonly options: ResponsesClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const apiKey = options.apiKey?.trim();
    this.authorization = apiKey ? `Bearer ${apiKey}` : undefined;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    try {
      const response = await this.fetchImpl(`${this.options.baseURL}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify(buildResponsesRequest(request)),
        signal: request.signal,
      });
      if (!response.ok) throw await createHttpError(response, request);
      if (!response.body) throw new Error('Copilot Relay streaming response has no body.');

      let started = false;
      let pendingTerminal: PendingTerminal | undefined;
      let sawDone = false;
      const seenCallIds = new Set<string>();
      for await (const data of readSseData(response.body, request.signal)) {
        if (data === '[DONE]') {
          if (!pendingTerminal) throw new Error('Copilot Relay sent [DONE] before a terminal event.');
          if (sawDone) throw new Error('Copilot Relay sent duplicate [DONE] markers.');
          sawDone = true;
          continue;
        }
        if (sawDone) throw new Error('Copilot Relay sent an event after [DONE].');

        const event = parseJsonRecord(data, 'Copilot Relay sent malformed SSE JSON.');
        const type = readString(event.type);
        if (!type) throw new Error('Copilot Relay SSE event type is missing.');
        if (!started && isOutputEventType(type)) {
          throw new Error(`Copilot Relay sent "${type}" before response.created.`);
        }
        if (pendingTerminal) {
          if (isTerminalType(type)) {
            throw new Error('Copilot Relay sent duplicate terminal events.');
          }
          throw new Error(`Copilot Relay sent "${type}" after its terminal event.`);
        }

        switch (type) {
          case 'response.created':
            if (started) throw new Error('Copilot Relay sent duplicate response.created events.');
            started = true;
            yield { type: 'message_start' };
            break;
          case 'response.output_text.delta': {
            if (!started) throw new Error('Copilot Relay sent text before response.created.');
            const text = readString(event.delta);
            if (text === undefined) throw new Error('Copilot Relay text delta is invalid.');
            yield { type: 'text_delta', text };
            break;
          }
          case 'response.output_item.done': {
            const item = asRecord(event.item);
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
            throw new Error('Copilot Relay reported a failed response.');
          default:
            if (isUnknownResponseState(type)) {
              throw new Error(`Copilot Relay sent unsupported response state "${type}".`);
            }
            break;
        }
      }
      if (!started) throw new Error('Copilot Relay stream ended before response.created.');
      if (!pendingTerminal) throw new Error('Copilot Relay stream ended before a terminal event.');
      yield { type: 'message_end', ...pendingTerminal };
    } catch (error) {
      yield {
        type: 'error',
        error: normalizeError(error, request),
      };
    }
  }

  async chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const content: ChatContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';
    let terminal: PendingTerminal | undefined;

    for await (const event of this.chatStream(request)) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          break;
        case 'tool_call':
          if (text) {
            content.push({ type: 'text', text });
            text = '';
          }
          toolCalls.push(event.call);
          if (event.call.input.state === 'ready') {
            content.push({
              type: 'tool_use',
              id: event.call.callId,
              name: event.call.name,
              input: { ...event.call.input.value },
            });
          }
          break;
        case 'message_end':
          if (event.stopReason !== 'end_turn'
            && event.stopReason !== 'tool_use'
            && event.stopReason !== 'max_tokens') {
            throw new Error(`Copilot Relay returned unsupported stop reason "${event.stopReason}".`);
          }
          terminal = Object.freeze({ stopReason: event.stopReason, usage: event.usage });
          break;
        case 'error':
          throw event.error;
        case 'message_start':
          break;
      }
    }
    if (text) content.push({ type: 'text', text });
    if (!terminal) throw new Error('Copilot Relay invocation completed without a terminal event.');
    return Object.freeze({
      content,
      toolCalls: Object.freeze(toolCalls),
      stopReason: terminal.stopReason,
      usage: terminal.usage,
    });
  }
}

function buildResponsesRequest(request: ModelInvocationRequest): Record<string, unknown> {
  return {
    model: request.model,
    max_output_tokens: request.maxTokens,
    stream: true,
    ...(request.system ? { instructions: request.system } : {}),
    input: convertMessages(request.messages),
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

function convertMessages(messages: readonly ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      input.push(messageItem(message.role, [{
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      }]));
      continue;
    }

    let pendingContent: unknown[] = [];
    const flush = (): void => {
      if (pendingContent.length === 0) return;
      input.push(messageItem(message.role, pendingContent));
      pendingContent = [];
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          pendingContent.push({
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
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
      }
    }
    flush();
  }
  return input;
}

function messageItem(role: ChatMessage['role'], content: unknown[]): Record<string, unknown> {
  return { role, content };
}

async function* readSseData(
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
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = parseSseBlock(block);
        if (data !== undefined) yield data;
      }
    }
    if (buffer.trim()) {
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
  if (seen.has(callId)) throw new Error(`Copilot Relay sent duplicate Tool Call id "${callId}".`);
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
  if (!response) throw new Error('Copilot Relay terminal response is invalid.');
  let stopReason: PendingTerminal['stopReason'];
  if (incomplete) {
    const details = asRecord(response.incomplete_details);
    if (details?.reason !== 'max_output_tokens') {
      throw new Error('Copilot Relay returned an unsupported incomplete reason.');
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

async function createHttpError(
  response: Response,
  request: ModelInvocationRequest,
): Promise<CopilotRelayInvocationError> {
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
    providerErrorType: sanitize(readString(nested?.type)),
    providerErrorCode: sanitize(readString(nested?.code)),
    providerMessage: sanitize(readString(nested?.message)),
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
      : [400, 404, 409, 422].includes(response.status)
        ? 'invalid_request'
        : response.status >= 500
          ? 'unavailable'
          : 'provider_failure';
  return new CopilotRelayInvocationError(category, diagnostics);
}

function normalizeError(error: unknown, request: ModelInvocationRequest): Error {
  if (error instanceof ModelInvocationError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new CopilotRelayInvocationError(
    error instanceof TypeError ? 'transport' : 'provider_failure',
    invocationDiagnostics(request, {}),
  );
}

function invocationDiagnostics(
  request: ModelInvocationRequest,
  provider: {
    httpStatus?: number;
    providerErrorType?: string;
    providerErrorCode?: string;
    providerMessage?: string;
    requestId?: string;
  },
): RelayInvocationDiagnostics {
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
      else toolResultBlockCount += 1;
    }
  }
  return {
    providerId: COPILOT_RELAY_PROVIDER_ID,
    ...provider,
    request: Object.freeze({
      model: request.model,
      maxTokens: request.maxTokens,
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

function parseJsonRecord(value: string, message: string): Record<string, unknown> {
  try {
    const parsed = asRecord(JSON.parse(value));
    if (parsed) return parsed;
  } catch {
    // Replaced by the bounded protocol error below.
  }
  throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNonEmptyString(value: unknown, field: string): string {
  const result = readString(value)?.trim();
  if (!result) throw new Error(`Copilot Relay ${field} is missing.`);
  return result;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Copilot Relay ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function sanitize(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
