import type {
  BeforeToolCallHook,
  BeforeToolCallPayload,
  BeforeToolCallResult,
  AfterToolCallHook,
  AfterToolCallPayload,
} from './types.js';

type NamedHandler<T> = { handler: T; name?: string };

/**
 * 顺序执行所有 before_tool_call hooks。
 *
 * - deny → 立即返回，后续 hook 不再执行
 * - allow + input → 更新 input，继续执行后续 hook
 * - 全部通过 → 返回最终 { action: 'allow', input }
 */
export async function runBeforeToolCall(
  hooks: NamedHandler<BeforeToolCallHook>[],
  payload: BeforeToolCallPayload,
): Promise<BeforeToolCallResult & { input: Record<string, unknown> }> {
  let currentInput = payload.input;

  for (const { handler, name } of hooks) {
    const result = await handler({ toolName: payload.toolName, input: currentInput });
    if (result.action === 'deny') {
      const tag = name ? `:${name}` : '';
      console.warn(`[hook${tag}] before_tool_call denied: tool=${payload.toolName} reason=${result.reason}`);
      return { action: 'deny', reason: result.reason, input: currentInput };
    }
    if ('input' in result) {
      currentInput = result.input;
    }
  }

  return { action: 'allow', input: currentInput };
}

/**
 * 并发执行所有 after_tool_call hooks（fire-and-forget）。
 * 任意 hook 抛出的错误只记录 warn log，不影响主流程。
 */
export function runAfterToolCall(
  hooks: NamedHandler<AfterToolCallHook>[],
  payload: AfterToolCallPayload,
): void {
  for (const { handler, name } of hooks) {
    Promise.resolve(handler(payload)).catch((err) => {
      const tag = name ? `:${name}` : '';
      console.warn(`[hook${tag}] after_tool_call failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
