// Core-owned model invocation contract. Provider adapters implement this port.

import type { ToolCall } from '../tools/types.js';

export type ChatRole = 'user' | 'assistant';

export type ThinkingWireProtocol =
  | 'openai-chat-completions'
  | 'openai-responses';

export interface InvocationSource {
  providerId: string;
  connectionId: string;
  requestModelId: string;
  responseModelId?: string;
  wireProtocol: ThinkingWireProtocol;
}

export interface InvocationUsage extends TokenUsage {
  reasoningTokens?: number;
}

export type InvocationCompletion =
  | {
      status: 'partial';
      stopReason: 'aborted' | 'error';
      usage?: InvocationUsage;
    }
  | {
      status: 'complete';
      stopReason: string;
      usage: InvocationUsage;
    };

export interface AssistantInvocation {
  id: string;
  source: InvocationSource;
  completion: InvocationCompletion;
}

export type ReplayJsonValue =
  | null
  | boolean
  | number
  | string
  | ReplayJsonValue[]
  | { [key: string]: ReplayJsonValue };

export interface ProviderReplayState {
  /** Provider-owned codec identifier. Core persists but never interprets it. */
  format: string;
  payload: { [key: string]: ReplayJsonValue };
}

export type ThinkingCompletion =
  | { status: 'partial'; text: string }
  | {
      status: 'complete';
      text: string;
      replay: ProviderReplayState;
    };

export type ThinkingContentBlock = {
  type: 'thinking';
  id: string;
} & ThinkingCompletion;

export interface PresentationThinkingBlock {
  type: 'thinking';
  id: string;
  text: string;
  status: 'partial' | 'complete';
}

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      /** Internal-only metadata; Provider adapters must not send it on the wire. */
      dimensions: { width: number; height: number };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      status: import('../tools/types.js').ToolResultStatus;
    }
  | { type: 'execution_accepted'; tool_use_id: string; execution_id: string }
  | ThinkingContentBlock;

export type PresentationContentBlock =
  | Exclude<ChatContentBlock, { type: 'thinking' }>
  | PresentationThinkingBlock;

export interface ChatMessage {
  role: ChatRole;
  /** Trusted Core origin; Provider adapters encode it as an ordinary user role. */
  origin?: 'host';
  content: string | ChatContentBlock[];
  /** Internal invocation metadata. Provider adapters must never serialize it directly. */
  invocation?: AssistantInvocation;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelInvocationRequest {
  model: string;
  /** Core-generated identity for this actual invocation. */
  invocationId?: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  outputTokenLimit?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelStreamEvent =
  | {
      type: 'message_start';
      invocation?: { id: string; source: InvocationSource };
    }
  | { type: 'thinking_start'; blockId: string }
  | { type: 'thinking_delta'; blockId: string; text: string }
  | { type: 'thinking_end'; blockId: string; completion: ThinkingCompletion }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'message_end'; stopReason: string; usage: TokenUsage }
  | { type: 'error'; error: Error };

export interface ModelInvocationResponse {
  content: ChatContentBlock[];
  invocation?: AssistantInvocation;
  /** Complete canonical calls; preserves malformed/non-object input state. */
  toolCalls: readonly ToolCall[];
  stopReason: string;
  usage: TokenUsage;
}

/** @deprecated Compatibility name. Use ModelInvocationResponse. */
export type ChatResponse = ModelInvocationResponse;

export interface ModelInvocationPort {
  chatStream(params: ModelInvocationRequest): AsyncIterable<ModelStreamEvent>;
  chat(params: ModelInvocationRequest): Promise<ModelInvocationResponse>;
}
