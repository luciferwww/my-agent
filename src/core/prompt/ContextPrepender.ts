import type { ContextHook, ContextHookMetadata } from './types.js';

/**
 * 管理 context hook 的注册和执行。
 * 按注册顺序执行所有 hook，收集非 null 结果。
 *
 * 参考 OpenClaw 的 prependContext 机制（attempt.ts / memory-lancedb 扩展）。
 */
export class ContextPrepender {
  private hooks: ContextHook[] = [];
  private turnIndex = 0;

  /** 注册 hook */
  register(hook: ContextHook): this {
    this.hooks.push(hook);
    return this;
  }

  /** 注销 hook */
  unregister(id: string): this {
    this.hooks = this.hooks.filter((h) => h.id !== id);
    return this;
  }

  /**
   * 执行所有 hooks，按注册顺序，收集非 null 结果。
   * 每次调用 turnIndex 自增。
   */
  async prepend(
    rawInput: string,
    metadata?: Record<string, unknown>,
  ): Promise<string[]> {
    const meta: ContextHookMetadata = {
      ...metadata,
      rawInput,
      turnIndex: this.turnIndex++,
    };

    const chunks: string[] = [];
    for (const hook of this.hooks) {
      const result = await hook.provider(rawInput, meta);
      if (result !== null && result.trim()) {
        chunks.push(result);
      }
    }

    return chunks;
  }
}
