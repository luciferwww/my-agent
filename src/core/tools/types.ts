/**
 * Tool execution context, passed to every tool invocation.
 *
 * Required fields (`sessionKey`, `turnId`, `toolUseId`) identify the run-time
 * origin of the call and are used by approval hooks, audit logs, and the
 * `task` subagent tool (which sets `parentToolUseId = ctx.toolUseId`).
 *
 * `signal` is reserved for the future abort subsystem (subagent spec §6.1
 * decision 1). v1 always sets it to `undefined`; the only current consumer
 * is the `exec` builtin tool, which degrades to no-abort behavior when the
 * signal is missing.
 */
export interface ToolContext {
  /** Tool run's owning sessionKey; used by approval hooks / routing / logs. */
  sessionKey: string;
  /** Tool run's owning turnId; same purpose as `sessionKey`. */
  turnId: string;
  /**
   * The id of the LLM `tool_use` block that triggered this invocation.
   * The `task` tool reads this to populate `SubagentRunInput.trigger.parentToolUseId`.
   */
  toolUseId: string;
  /** Reserved for the future abort subsystem; v1 is always `undefined`. */
  signal?: AbortSignal;
}

/** Tool execution result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * Tool execution callback.
 * agent-runner uses this type as a constructor dependency.
 */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/** Tool definition. */
export interface Tool {
  /** Tool name, used as the unique identifier exposed to the LLM. */
  name: string;
  /** Tool description, used to help the LLM decide when to call it. */
  description: string;
  /** JSON Schema for the tool input, exposed to the LLM. */
  inputSchema: Record<string, unknown>;
  /** Tool implementation. */
  execute: (
    params: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}

/** Tool definition sent to the LLM, without the execute function. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
