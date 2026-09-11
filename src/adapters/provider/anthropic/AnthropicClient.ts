import Anthropic from '@anthropic-ai/sdk';
import {
  ContextOverflowError,
  ModelInvocationError,
} from '../../../core/model-invocation/index.js';
import type {
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ChatContentBlock,
  ModelStreamEvent,
  TokenUsage,
  ChatMessage,
  ChatToolDefinition,
} from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';
import { encodeAnthropicToolDefinition } from './tool-codec.js';

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
}

/**
 * Anthropic SDK implementation of ModelInvocationPort.
 *
 * 支持自定义 baseURL，可对接 LiteLLM Proxy、MAI-LLMProxy 等代理。
 *
 * NOTE: 部分代理（如 LLMProxy）可能不返回完整的 usage 信息，
 * 例如 input_tokens 返回 0。这是代理的行为，不影响功能。
 *
 * 参考 OpenClaw 的 pi-ai 库中 anthropic provider 的实现。
 */
export class AnthropicClient implements ModelInvocationPort {
  private client: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  /** Convert Anthropic SDK events into canonical ModelStreamEvent values. */
  async *chatStream(params: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const messages = convertMessages(params.messages);
    const tools = params.tools ? convertTools(params.tools) : undefined;

    try {
      const stream = this.client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens,
        messages,
        ...(params.system ? { system: params.system } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
      }, {
        signal: params.signal,
      });

      yield { type: 'message_start' };

      let currentToolUse: {
        id: string;
        name: string;
        inputJson: string;
      } | null = null;
      const seenToolCallIds = new Set<string>();

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              currentToolUse = {
                id: block.id,
                name: block.name,
                inputJson: '',
              };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.inputJson += delta.partial_json;
            }
            break;
          }

          case 'content_block_stop': {
            if (currentToolUse) {
              if (currentToolUse.id.trim() === '' || currentToolUse.name.trim() === '') {
                throw new Error('Anthropic Tool Call id and name must be non-empty.');
              }
              if (seenToolCallIds.has(currentToolUse.id)) {
                throw new Error(`Duplicate Anthropic Tool Call id "${currentToolUse.id}".`);
              }
              seenToolCallIds.add(currentToolUse.id);
              let input:
                | { readonly state: 'ready'; readonly value: Readonly<Record<string, unknown>> }
                | { readonly state: 'invalid'; readonly reason: 'malformed_json' | 'not_an_object' };
              try {
                const decoded: unknown = JSON.parse(currentToolUse.inputJson || '{}');
                input = isPlainObject(decoded)
                  ? { state: 'ready', value: decoded }
                  : { state: 'invalid', reason: 'not_an_object' };
              } catch {
                input = { state: 'invalid', reason: 'malformed_json' };
              }
              yield {
                type: 'tool_call',
                call: Object.freeze({
                  callId: currentToolUse.id,
                  name: currentToolUse.name,
                  input: Object.freeze(input),
                }),
              };
              currentToolUse = null;
            }
            break;
          }

          case 'message_stop': {
            break;
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      yield {
        type: 'message_end',
        stopReason: finalMessage.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield {
        type: 'error',
        error: normalizeProviderError(error, params),
      };
    }
  }

  /** Collect a complete response from the streaming implementation. */
  async chat(params: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const contentBlocks: ChatContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let currentText = '';
    let stopReason = 'end_turn';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of this.chatStream(params)) {
      switch (event.type) {
        case 'text_delta':
          currentText += event.text;
          break;

        case 'tool_call':
          toolCalls.push(event.call);
          if (currentText) {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          if (event.call.input.state === 'ready') {
            contentBlocks.push({
              type: 'tool_use',
              id: event.call.callId,
              name: event.call.name,
              input: { ...event.call.input.value },
            });
          }
          break;

        case 'message_end':
          stopReason = event.stopReason;
          usage = event.usage;
          break;

        case 'error':
          throw event.error;
      }
    }

    if (currentText) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    return {
      content: contentBlocks,
      toolCalls: Object.freeze(toolCalls),
      stopReason,
      usage,
    };
  }
}

function normalizeProviderError(error: Error, request: ModelInvocationRequest): Error {
  if (error.name === 'AbortError') {
    return error;
  }
  if (isProviderContextOverflow(error)) {
    return new ContextOverflowError('Provider reported a context overflow.');
  }

  const diagnostics = buildInvocationDiagnostics(error, request);
  const status = diagnostics.httpStatus;
  if (status === 401 || status === 403) {
    return new ModelInvocationError('authentication', diagnostics);
  }
  if (status === 429) {
    return new ModelInvocationError('rate_limit', diagnostics);
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return new ModelInvocationError('invalid_request', diagnostics);
  }
  if (status !== undefined && status >= 500) {
    return new ModelInvocationError('unavailable', diagnostics);
  }
  return new ModelInvocationError(
    status === undefined ? 'transport' : 'provider_failure',
    diagnostics,
  );
}

function buildInvocationDiagnostics(error: Error, request: ModelInvocationRequest) {
  const sdkError = asRecord(error);
  const errorPayload = asRecord(sdkError?.error);
  const nestedError = asRecord(errorPayload?.error);
  const providerMessage = sanitizeProviderMessage(
    readString(nestedError, 'message') ?? readString(errorPayload, 'message'),
  );
  const providerErrorType = readString(nestedError, 'type')
    ?? readString(errorPayload, 'type')
    ?? readString(sdkError, 'type');
  const requestId = readString(sdkError, 'requestID');

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
      switch (block.type) {
        case 'text': textBlockCount += 1; break;
        case 'image': imageBlockCount += 1; break;
        case 'tool_use': toolUseBlockCount += 1; break;
        case 'tool_result': toolResultBlockCount += 1; break;
      }
    }
  }

  return Object.freeze({
    providerId: 'anthropic-compatible',
    ...(typeof sdkError?.status === 'number' ? { httpStatus: sdkError.status } : {}),
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(requestId ? { requestId } : {}),
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
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function readString(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function sanitizeProviderMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, 500) : undefined;
}

function isProviderContextOverflow(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('request_too_large')
    || message.includes('context_length_exceeded')
    || message.includes('prompt is too long')
    || message.includes('maximum context length')
  );
}

function toAnthropicContentBlock(
  block: ChatContentBlock,
): ChatContentBlock | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  if (block.type === 'image') {
    return { type: 'image', source: block.source };
  }
  return block;
}

function convertMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === 'string'
      ? msg.content
      : (msg.content.map(toAnthropicContentBlock) as Anthropic.MessageParam['content']),
  }));
}

function convertTools(tools: ChatToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => {
    const wire = encodeAnthropicToolDefinition(tool);
    return {
      ...wire,
      input_schema: wire.input_schema as Anthropic.Tool.InputSchema,
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}