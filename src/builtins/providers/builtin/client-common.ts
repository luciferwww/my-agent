import {
  ContextOverflowError,
  ModelInvocationError,
} from '../../../core/model-invocation/index.js';
import type {
  ChatContentBlock,
  ModelInvocationDiagnostics,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
  TokenUsage,
} from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';

export interface ProtocolClientOptions {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

export interface Terminal {
  readonly stopReason: string;
  readonly usage: TokenUsage;
}

const MAX_SSE_EVENT_BUFFER_CHARS = 1024 * 1024;

export async function collectChat(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelInvocationResponse> {
  const content: ChatContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  let text = '';
  let terminal: Terminal | undefined;
  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        break;
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
        terminal = { stopReason: event.stopReason, usage: event.usage };
        break;
      case 'error':
        throw event.error;
    }
  }
  if (!terminal) throw new Error('Model invocation completed without a terminal event.');
  if (text) content.push({ type: 'text', text });
  return Object.freeze({
    content,
    toolCalls: Object.freeze(toolCalls),
    stopReason: terminal.stopReason,
    usage: terminal.usage,
  });
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
        const match = /(?:\r\n(?:\r\n|\r|\n)|\r(?:\r\n|\r)|\n(?:\r\n|\r|\n))/u.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = parseSseBlock(block);
        if (data !== undefined) yield data;
      }
      if (buffer.length > MAX_SSE_EVENT_BUFFER_CHARS) {
        throw new Error('Provider SSE event exceeds the supported size.');
      }
    }
    if (buffer.length > MAX_SSE_EVENT_BUFFER_CHARS) {
      throw new Error('Provider SSE event exceeds the supported size.');
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

function parseSseBlock(block: string): string | undefined {
  const values: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/u)) {
    if (line.startsWith('data:')) values.push(line.slice(5).replace(/^ /u, ''));
  }
  return values.length ? values.join('\n') : undefined;
}

export async function createHttpError(
  response: Response,
  request: ModelInvocationRequest,
  maxTokens?: number,
): Promise<ModelInvocationError | ContextOverflowError> {
  const body = await readBoundedText(response, 64 * 1024, request.signal);
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(JSON.parse(body));
  } catch {
    payload = undefined;
  }
  const nested = asRecord(payload?.error);
  const type = sanitize(readString(nested?.type) ?? readString(payload?.type));
  const code = sanitize(readString(nested?.code));
  const message = sanitize(readString(nested?.message) ?? readString(payload?.message));
  if (isContextOverflow(`${type ?? ''} ${code ?? ''} ${message ?? ''}`)) {
    return new ContextOverflowError('Provider reported a context overflow.');
  }
  return new ModelInvocationError(categoryForStatus(response.status), diagnostics(request, {
    httpStatus: response.status,
    providerErrorType: type,
    providerErrorCode: code,
    providerMessage: message,
    requestId: sanitize(
      response.headers.get('request-id')
      ?? response.headers.get('x-request-id')
      ?? readString(payload?.request_id),
    ),
  }, maxTokens));
}

export function normalizeError(
  error: unknown,
  request: ModelInvocationRequest,
  maxTokens?: number,
): Error {
  if (error instanceof ModelInvocationError || error instanceof ContextOverflowError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const message = error instanceof Error ? error.message : '';
  if (isContextOverflow(message)) {
    return new ContextOverflowError('Provider reported a context overflow.');
  }
  return new ModelInvocationError(
    error instanceof TypeError ? 'transport' : 'provider_failure',
    diagnostics(request, {}, maxTokens),
  );
}

export function createStreamError(
  payload: Record<string, unknown>,
  request: ModelInvocationRequest,
  maxTokens?: number,
): ModelInvocationError | ContextOverflowError {
  const response = asRecord(payload.response);
  const nested = asRecord(payload.error) ?? asRecord(response?.error);
  const providerErrorType = sanitize(
    readString(nested?.type)
    ?? readString(payload.type),
  );
  const providerErrorCode = sanitize(
    readString(nested?.code)
    ?? readString(payload.code),
  );
  const providerMessage = sanitize(
    readString(nested?.message)
    ?? readString(payload.message),
  );
  const details = `${providerErrorType ?? ''} ${providerErrorCode ?? ''} ${providerMessage ?? ''}`;
  if (isContextOverflow(details)) {
    return new ContextOverflowError('Provider reported a context overflow.');
  }
  return new ModelInvocationError(
    categoryForProviderError(details),
    diagnostics(request, {
      providerErrorType,
      providerErrorCode,
      providerMessage,
      requestId: sanitize(
        readString(payload.request_id)
        ?? readString(response?.request_id),
      ),
    }, maxTokens),
  );
}

function diagnostics(
  request: ModelInvocationRequest,
  provider: {
    readonly httpStatus?: number;
    readonly providerErrorType?: string;
    readonly providerErrorCode?: string;
    readonly providerMessage?: string;
    readonly requestId?: string;
  },
  maxTokens?: number,
): ModelInvocationDiagnostics {
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
  return Object.freeze({
    providerId: 'builtin',
    ...provider,
    request: Object.freeze({
      model: request.model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
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
  });
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
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function categoryForStatus(status: number) {
  if (status === 401 || status === 403) return 'authentication' as const;
  if (status === 429) return 'rate_limit' as const;
  if ([400, 404, 409, 422].includes(status)) return 'invalid_request' as const;
  if (status >= 500) return 'unavailable' as const;
  return 'provider_failure' as const;
}

function categoryForProviderError(value: string): ModelInvocationError['category'] {
  const normalized = value.toLowerCase();
  if (
    normalized.includes('authentication')
    || normalized.includes('unauthorized')
    || normalized.includes('invalid_api_key')
    || normalized.includes('permission')
  ) {
    return 'authentication';
  }
  if (normalized.includes('rate_limit') || normalized.includes('quota')) {
    return 'rate_limit';
  }
  if (normalized.includes('overloaded') || normalized.includes('unavailable')) {
    return 'unavailable';
  }
  if (
    normalized.includes('invalid_request')
    || normalized.includes('bad_request')
    || normalized.includes('unsupported')
  ) {
    return 'invalid_request';
  }
  return 'provider_failure';
}

function isContextOverflow(value: string): boolean {
  const message = value.toLowerCase();
  return message.includes('context_length_exceeded')
    || message.includes('request_too_large')
    || message.includes('prompt is too long')
    || message.includes('maximum context length');
}

export function parseRecord(value: string, message: string): Record<string, unknown> {
  try {
    const result = asRecord(JSON.parse(value));
    if (result) return result;
  } catch {
    // Emit the stable protocol failure below.
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
  if (!result) throw new Error(`${field} is missing.`);
  return result;
}

export function readNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value as number;
}

export function parseToolInput(value: unknown): ToolCall['input'] {
  try {
    const decoded = JSON.parse(readString(value) ?? '');
    const record = asRecord(decoded);
    return record
      ? Object.freeze({ state: 'ready', value: Object.freeze({ ...record }) })
      : Object.freeze({ state: 'invalid', reason: 'not_an_object' });
  } catch {
    return Object.freeze({ state: 'invalid', reason: 'malformed_json' });
  }
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
