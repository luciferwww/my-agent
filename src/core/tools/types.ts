/**
 * Tool execution context, passed to every tool invocation.
 *
 * Required fields (`sessionKey`, `turnId`, `toolUseId`) identify the run-time
 * origin of the call and are used by approval hooks, audit logs, and the
 * `task` subagent tool (which sets `parentToolUseId = ctx.toolUseId`).
 *
 * `signal` carries user abort / turn timeout / shutdown interrupts. Whether
 * a tool actually responds is decided per tool (see field JSDoc). Abort's
 * invariant is "stop the LOOP (no next tool starts)"; in-flight tool calls
 * are NOT guaranteed to terminate immediately. See core-abort-spec.md §6.2.
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
  /**
   * User abort / turn timeout / shutdown interrupt signal.
   *
   * Contract: my-agent guarantees a valid signal is passed, but whether the
   * tool responds is **decided by each tool**. Abort's invariant is "stop the
   * LOOP (no next tool starts)"; it does **not** guarantee in-flight calls
   * terminate. Reason: MCP / third-party tools are heterogeneous and cannot
   * be forced to implement signal handling.
   *
   * v1 actual behavior:
   *  - `exec` tool: reads `ctx.signal` and forwards to `child_process` → killed
   *  - other builtins (`web_fetch` / `search` / `fs` / `apply_patch`): v1 does
   *    not respond; runs to completion
   *  - MCP / third-party tools: response is up to the implementation
   *
   * Third-party tool authors: for long operations (>500ms) please check
   * `if (ctx.signal?.aborted)` around await points and throw `AbortError`.
   */
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
