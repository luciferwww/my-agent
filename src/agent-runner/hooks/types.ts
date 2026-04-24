import type { ToolResult } from '../../tools/types.js';

// ── before_tool_call ─────────────────────────────────────────────────────────

export interface BeforeToolCallPayload {
  toolName: string;
  input: Record<string, unknown>;
}

export type BeforeToolCallResult =
  | { action: 'allow' }
  | { action: 'allow'; input: Record<string, unknown> }
  | { action: 'deny'; reason: string };

export type BeforeToolCallHook = (
  payload: BeforeToolCallPayload,
) => BeforeToolCallResult | Promise<BeforeToolCallResult>;

// ── after_tool_call ──────────────────────────────────────────────────────────

export interface AfterToolCallPayload {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
}

export type AfterToolCallHook = (
  payload: AfterToolCallPayload,
) => void | Promise<void>;

// ── Hook 注册系统 ─────────────────────────────────────────────────────────────

export type HookName = 'before_tool_call' | 'after_tool_call';

export type HookHandlerMap = {
  before_tool_call: BeforeToolCallHook;
  after_tool_call: AfterToolCallHook;
};

export interface HookRegistration<K extends HookName = HookName> {
  hookName: K;
  handler: HookHandlerMap[K];
  /** 执行优先级，数字越大越先执行，默认 0（对齐 OpenClaw） */
  priority: number;
  /** 可选标识符，用于 warn log 定位 */
  name?: string;
}
