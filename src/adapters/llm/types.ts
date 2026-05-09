// ── 消息类型（独立于 session 模块，对齐 Anthropic API） ─────

export type ChatRole = 'user' | 'assistant';

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentBlock[];
}

// ── 工具定义（独立于 prompt-builder 模块） ──────────────────

export interface ChatToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ── 调用参数 ────────────────────────────────────────────────

export interface ChatParams {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}

// ── 流式事件 ────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_end'; stopReason: string; usage: TokenUsage }
  | { type: 'error'; error: Error };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ── 非流式响应 ──────────────────────────────────────────────

export interface ChatResponse {
  content: ChatContentBlock[];
  stopReason: string;
  usage: TokenUsage;
}

// ── LLMClient 抽象接口 ─────────────────────────────────────

export interface LLMClient {
  /**
   * 流式调用 LLM。
   * 返回 AsyncIterable，逐个 yield StreamEvent。
   */
  chatStream(params: ChatParams): AsyncIterable<StreamEvent>;

  /**
   * 非流式调用 LLM（便捷方法）。
   * 内部调用 chatStream 收集完整响应后返回。
   */
  chat(params: ChatParams): Promise<ChatResponse>;
}
