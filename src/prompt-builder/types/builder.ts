import type { PromptMode } from './core.js';
import type { MediaAttachment } from './media.js';

export type { ContextFile } from '../../types/context-file.js';

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 格式的参数定义（可选） */
  parameters?: Record<string, unknown>;
}

/**
 * SystemPromptBuilder.build() 的参数。
 * 所有字段均为可选，未传入时各 Section 使用默认值或跳过。
 */
export interface SystemPromptBuildParams {
  /** 构建模式，默认 'full' */
  mode?: PromptMode;
  /** 可用工具列表，不传或空数组则跳过工具相关 Section */
  tools?: ToolDefinition[];
  /** 安全约束级别，默认 'normal'，'relaxed' 跳过安全 Section */
  safetyLevel?: 'strict' | 'normal' | 'relaxed';
  /** 注入的上下文文件（IDENTITY.md、SOUL.md 等） */
  contextFiles?: import('../../types/context-file.js').ContextFile[];
}

/** UserPromptBuilder.build() 的输入 */
export interface UserPromptInput {
  /** 用户原始文本输入 */
  text: string;
  /** 媒体附件，单独返回供 LLM API 处理 */
  attachments?: MediaAttachment[];
  /** 传给 context hook 的额外数据 */
  metadata?: Record<string, unknown>;
}

/** UserPromptBuilder.build() 的输出 */
export interface BuiltUserPrompt {
  /** 最终拼接文本（hooks + 原始输入） */
  text: string;
  /** 媒体附件，单独传入 LLM API */
  attachments: MediaAttachment[];
  /** 调试信息 */
  _debug?: {
    rawInput: string;
    prependedChunks: string[];
  };
}
