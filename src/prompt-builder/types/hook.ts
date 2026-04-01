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
