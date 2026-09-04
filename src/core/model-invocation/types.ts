// Core-owned model invocation contract. Provider adapters implement this port.

export type ChatRole = 'user' | 'assistant';

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      /** Internal-only metadata; Provider adapters must not send it on the wire. */
      dimensions: { width: number; height: number };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentBlock[];
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelInvocationRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** @deprecated Compatibility name. Use ModelInvocationRequest. */
export type ChatParams = ModelInvocationRequest;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelStreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_end'; stopReason: string; usage: TokenUsage }
  | { type: 'error'; error: Error };

/** @deprecated Compatibility name. Use ModelStreamEvent. */
export type StreamEvent = ModelStreamEvent;

export interface ModelInvocationResponse {
  content: ChatContentBlock[];
  stopReason: string;
  usage: TokenUsage;
}

/** @deprecated Compatibility name. Use ModelInvocationResponse. */
export type ChatResponse = ModelInvocationResponse;

export interface ModelInvocationPort {
  chatStream(params: ModelInvocationRequest): AsyncIterable<ModelStreamEvent>;
  chat(params: ModelInvocationRequest): Promise<ModelInvocationResponse>;
}

/** @deprecated Compatibility name. Use ModelInvocationPort. */
export type LLMClient = ModelInvocationPort;
