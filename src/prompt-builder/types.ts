import type { ContextFile } from '../workspace/types.js';

export type { ContextFile };

/** Prompt 构建模式 */
export type PromptMode = 'full' | 'minimal' | 'none';

/** 媒体附件类型 */
export type MediaType = 'image' | 'file';

/** 图像附件（base64 编码） */
export interface ImageAttachment {
  type: 'image';
  /** base64 编码的图像内容 */
  data: string;
  /** MIME 类型，如 'image/jpeg'、'image/png' */
  mimeType: string;
  /** 可选的用户说明文字 */
  caption?: string;
}

/** 文件附件 */
export interface FileAttachment {
  type: 'file';
  /** 文件名 */
  filename: string;
  /** 文件内容 */
  content: string;
  /** MIME 类型 */
  mimeType: string;
  /** 可选的用户说明文字 */
  caption?: string;
}

/** 联合类型：所有支持的媒体附件 */
export type MediaAttachment = ImageAttachment | FileAttachment;

/** User Prompt 前置上下文注入 hook */
export interface ContextHook {
  /** hook 唯一标识符 */
  id: string;
  /**
   * 上下文提供函数。
   * 返回要前置到用户消息的文本块，返回 null 则跳过。
   */
  provider: (
    rawInput: string,
    metadata: ContextHookMetadata,
  ) => string | null | Promise<string | null>;
}

/** 传递给 ContextHook.provider 的元数据 */
export interface ContextHookMetadata {
  /** 用户原始输入文本 */
  rawInput: string;
  /** 当前对话轮次（从 0 开始，每次 build 自增） */
  turnIndex: number;
  /** 调用方传入的自定义元数据 */
  [key: string]: unknown;
}

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
  contextFiles?: ContextFile[];
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
