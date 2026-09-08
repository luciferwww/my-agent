/**
 * Tool execution context, passed to every tool invocation.
 *
 * Required fields (`sessionKey`, `turnId`, `callId`) identify the run-time
 * origin of the call and are used by approval hooks, audit logs, and the
 * `task` subagent tool (which sets `parentToolUseId = ctx.callId`).
 *
 * `signal` carries user abort / turn timeout / shutdown interrupts. Whether
 * a tool actually responds is decided per tool (see field JSDoc). Abort's
 * invariant is "stop the LOOP (no next tool starts)"; in-flight tool calls
 * are NOT guaranteed to terminate immediately. See core-abort-spec.md §6.2.
 */
export interface ToolExecutionContext {
  /** Tool run's owning sessionKey; used by approval hooks / routing / logs. */
  readonly sessionKey: string;
  /** Tool run's owning turnId; same purpose as `sessionKey`. */
  readonly turnId: string;
  /**
   * The id of the LLM `tool_use` block that triggered this invocation.
  * The `task` tool reads this to populate Parent correlation on delegation.
   */
  readonly callId: string;
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
  readonly signal: AbortSignal;
}

/** Existing public event/presentation result shape; not a Tool implementation contract. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Canonical output reported by a Tool implementation. */
export interface ToolExecutionOutput {
  readonly outcome: 'success' | 'failed';
  readonly content: string;
}

export type ToolResultOutcome =
  | 'success'
  | 'unknown_tool'
  | 'denied'
  | 'invalid_input'
  | 'unavailable'
  | 'failed'
  | 'aborted'
  | 'not_executed'
  | 'outcome_unknown';

export type ToolCallInput =
  | { readonly state: 'ready'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly state: 'invalid'; readonly reason: 'malformed_json' | 'not_an_object' };

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: ToolCallInput;
}

export interface CanonicalToolResult {
  readonly callId: string;
  readonly outcome: ToolResultOutcome;
  readonly content: string;
}

/** Tool definition. */
export interface Tool {
  /** Tool name, used as the unique identifier exposed to the LLM. */
  readonly name: string;
  /** Tool description, used to help the LLM decide when to call it. */
  readonly description: string;
  /** JSON Schema for the tool input, exposed to the LLM. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Tool implementation. */
  execute: (
    params: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionOutput>;
}

/** Tool definition sent to the LLM, without the execute function. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ToolPolicyDecision = 'allow' | 'deny' | 'requires_approval';

export interface ApplicationToolPolicy {
  isDenied(toolName: string): boolean;
  decide(toolName: string, hasApprovalCapability: boolean): ToolPolicyDecision;
}
