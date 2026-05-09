/** Tool execution context, optionally used to pass an AbortSignal and similar metadata. */
export interface ToolContext {
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
    context?: ToolContext,
  ) => Promise<ToolResult>;
}

/** Tool definition sent to the LLM, without the execute function. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
