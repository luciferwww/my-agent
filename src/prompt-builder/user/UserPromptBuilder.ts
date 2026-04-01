import { ContextPrepender } from './ContextPrepender.js';
import type {
  ContextHook,
  UserPromptInput,
  BuiltUserPrompt,
} from '../types/index.js';

/**
 * 构建 User Prompt。
 *
 * 拼接顺序（参考 OpenClaw prepend 模式）：
 *   hooks 前置文本块（按注册顺序）
 *   用户原始消息（永远在最后）
 *
 * 媒体附件单独返回，不嵌入文本（与 OpenClaw 一致）。
 */
export class UserPromptBuilder {
  private prepender = new ContextPrepender();

  /** 注册 context hook（链式） */
  useContextHook(hook: ContextHook): this {
    this.prepender.register(hook);
    return this;
  }

  /** 注销 context hook（链式） */
  removeContextHook(id: string): this {
    this.prepender.unregister(id);
    return this;
  }

  /** 构建 User Prompt */
  async build(input: UserPromptInput): Promise<BuiltUserPrompt> {
    const { text: rawInput, attachments = [], metadata = {} } = input;

    // 收集前置上下文
    const prependedChunks = await this.prepender.prepend(rawInput, metadata);

    // 拼接：hooks → 原始消息
    const parts = [...prependedChunks, rawInput].filter(Boolean);
    const text = parts.join('\n\n');

    return {
      text,
      attachments,
      _debug: {
        rawInput,
        prependedChunks,
      },
    };
  }
}
