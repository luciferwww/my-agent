import Anthropic from '@anthropic-ai/sdk';
import {
  ContextOverflowError,
  ModelInvocationError,
} from '../../core/model-invocation/index.js';
import type {
  LLMClient,
  ChatParams,
  ChatResponse,
  ChatContentBlock,
  StreamEvent,
  TokenUsage,
  ChatMessage,
  ChatToolDefinition,
} from './types.js';
import { encodeAnthropicToolDefinition } from './tool-contract-codecs.js';
import type { ToolCall } from '../../core/tools/index.js';

const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
}

/**
 * Anthropic SDK 实现的 LLMClient。
 *
 * 支持自定义 baseURL，可对接 LiteLLM Proxy、MAI-LLMProxy 等代理。
 *
 * NOTE: 部分代理（如 LLMProxy）可能不返回完整的 usage 信息，
 * 例如 input_tokens 返回 0。这是代理的行为，不影响功能。
 *
 * 参考 OpenClaw 的 pi-ai 库中 anthropic provider 的实现。
 */
export class AnthropicClient implements LLMClient {
  private client: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  /**
   * 流式调用 Anthropic API。
   * 将 Anthropic SDK 的事件格式转换为我们的 StreamEvent。
   */
  async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
    const messages = convertMessages(params.messages);
    const tools = params.tools ? convertTools(params.tools) : undefined;

    try {
      const stream = this.client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages,
        ...(params.system ? { system: params.system } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
      }, {
        signal: params.signal,
      });

      yield { type: 'message_start' };

      // 收集 tool_use 块（Anthropic 流式 tool_use 是分多个事件推送的）
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
            // 最终消息从 stream 的 finalMessage 获取
            break;
          }
        }
      }

      // 获取最终消息（含 usage 和 stop_reason）
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
        error: normalizeProviderError(error),
      };
    }
  }

  /**
   * 非流式调用（便捷方法）。
   * 内部调用 chatStream 收集完整响应后返回。
   *
   * 与 OpenClaw 的 Agent.prompt() 思路一致：
   * 对外暴露简单的 async/await 接口，内部始终用流式。
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
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
          // 先把累积的文本作为一个 text block
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

    // 最后的文本
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

function normalizeProviderError(error: Error): Error {
  if (error.name === 'AbortError') {
    return error;
  }
  if (isProviderContextOverflow(error)) {
    return new ContextOverflowError('Provider reported a context overflow.');
  }

  const status = 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
  if (status === 401 || status === 403) {
    return new ModelInvocationError('authentication');
  }
  if (status === 429) {
    return new ModelInvocationError('rate_limit');
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return new ModelInvocationError('invalid_request');
  }
  if (status !== undefined && status >= 500) {
    return new ModelInvocationError('unavailable');
  }
  return new ModelInvocationError(status === undefined ? 'transport' : 'provider_failure');
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

// ── 内部转换函数 ────────────────────────────────────────────

/**
 * 出站去掉 image 上的 `dimensions`（内部 metadata，不属于 Anthropic API）。
 * 其他 block 透传。
 */
function toAnthropicContentBlock(block: ChatContentBlock): ChatContentBlock | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  if (block.type === 'image') {
    return { type: 'image', source: block.source };
  }
  return block;
}

/**
 * 将我们的 ChatMessage 转换为 Anthropic SDK 的消息格式。
 * 两者结构相同（都对齐 Anthropic API），但 image block 需 strip dimensions（内部字段）。
 */
function convertMessages(
  messages: ChatMessage[],
): Anthropic.MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content:
      typeof msg.content === 'string'
        ? msg.content
        : (msg.content.map(toAnthropicContentBlock) as Anthropic.MessageParam['content']),
  }));
}

/**
 * 将我们的 ChatToolDefinition 转换为 Anthropic SDK 的工具格式。
 */
function convertTools(
  tools: ChatToolDefinition[],
): Anthropic.Tool[] {
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
