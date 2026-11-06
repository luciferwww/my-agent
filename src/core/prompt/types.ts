import type { ContextFile } from '../agent-context/types.js';
import type { AvailableSubagentEntry } from '../subagent/available-subagents.js';

export type { ContextFile };

export type PromptMode = 'full' | 'minimal' | 'none';

export type MediaType = 'image' | 'file';

export interface ImageAttachment {
  type: 'image';
  /** Base64-encoded image content. */
  data: string;
  mimeType: string;
  caption?: string;
}

export interface FileAttachment {
  type: 'file';
  filename: string;
  content: string;
  mimeType: string;
  caption?: string;
}

export type MediaAttachment = ImageAttachment | FileAttachment;

export interface ContextHook {
  id: string;
  /** Returns text to prepend to the user prompt, or null to skip injection. */
  provider: (
    rawInput: string,
    metadata: ContextHookMetadata,
  ) => string | null | Promise<string | null>;
}

export interface ContextHookMetadata {
  rawInput: string;
  /** Zero-based turn index, incremented on each build. */
  turnIndex: number;
  /** Caller-provided metadata. */
  [key: string]: unknown;
}

export interface SystemPromptBuildParams {
  /** Defaults to 'full'. */
  mode?: PromptMode;
  /** Narrow Tool-name projection used only for capability-conditional prompt sections. */
  toolNames?: readonly string[];
  contextFiles?: ContextFile[];
  /** Agent Home absolute path rendered in every mode except `'none'`. */
  agentHome?: string;
  /** Injected by prompt-factory only in full mode when subagents are enabled. */
  availableSubagents?: AvailableSubagentEntry[];
}

export interface UserPromptInput {
  text: string;
  /** Returned separately for the LLM API. */
  attachments?: MediaAttachment[];
  /** Additional data passed to context hooks. */
  metadata?: Record<string, unknown>;
}

export interface BuiltUserPrompt {
  /** Assembled prompt text, including injected context and user input. */
  text: string;
  /** Passed separately to the LLM API. */
  attachments: MediaAttachment[];
  _debug?: {
    rawInput: string;
    prependedChunks: string[];
  };
}
