import Anthropic from '@anthropic-ai/sdk';
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
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(currentToolUse.inputJson || '{}');
              } catch {
                // 解析失败使用空对象
              }
              yield {
                type: 'tool_use',
                id: currentToolUse.id,
                name: currentToolUse.name,
                input,
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
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
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
    let currentText = '';
    let stopReason = 'end_turn';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of this.chatStream(params)) {
      switch (event.type) {
        case 'text_delta':
          currentText += event.text;
          break;

        case 'tool_use':
          // 先把累积的文本作为一个 text block
          if (currentText) {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          contentBlocks.push({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          });
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

    return { content: contentBlocks, stopReason, usage };
  }
}

// ── 内部转换函数 ────────────────────────────────────────────

/**
 * 将我们的 ChatMessage 转换为 Anthropic SDK 的消息格式。
 * 两者结构相同（都对齐 Anthropic API），直接透传。
 */
function convertMessages(
  messages: ChatMessage[],
): Anthropic.MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content as Anthropic.MessageParam['content'],
  }));
}

/**
 * 将我们的 ChatToolDefinition 转换为 Anthropic SDK 的工具格式。
 */
function convertTools(
  tools: ChatToolDefinition[],
): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));
}
