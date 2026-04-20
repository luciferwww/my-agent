/**
 * AgentRunner 错误类型。
 *
 * 将上下文溢出单独抽象为一种错误，使外层 retry 循环可以精准捕获并执行压缩，
 * 而不会误捕获其他类型的运行时错误（如工具错误、网络错误等）。
 */

/**
 * 上下文溢出错误。
 *
 * 有三条触发路径（均由外层 retry 循环统一处理）：
 *   1. 预判检测（runAttempt 开头）：checkContextBudget 返回 'compact' 路由
 *   2. 内层 90% 阈值检查：tool result 追加后 estimatedTokens > contextWindow × 0.9
 *   3. LLM API 被动兜底：callLLMStream 收到 context overflow 类型的 API 错误
 */
export class ContextOverflowError extends Error {
  readonly trigger: 'preemptive' | 'overflow';

  constructor(message: string, trigger: 'preemptive' | 'overflow' = 'overflow') {
    super(message);
    this.name = 'ContextOverflowError';
    this.trigger = trigger;
  }
}

/**
 * 判断一个 Error 是否来自 LLM API 的上下文溢出响应。
 *
 * 不同 API 提供商返回的错误消息格式不同，此函数统一做关键词匹配。
 * 匹配到则由 callLLMStream 包装成 ContextOverflowError 向上抛出，
 * 使外层 retry 循环能够统一处理。
 *
 * 覆盖的场景：
 *   - Anthropic: 'request_too_large'
 *   - OpenAI / 兼容接口: 'context_length_exceeded'
 *   - 通用描述: 'prompt is too long', 'maximum context length'
 */
export function isContextOverflowError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('request_too_large') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context length')
  );
}
