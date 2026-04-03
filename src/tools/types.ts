/** 工具执行上下文（可选，用于传递 signal 等） */
export interface ToolContext {
  signal?: AbortSignal;
}

/** 工具执行结果 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * 工具执行回调。
 * agent-runner 引用此类型作为构造参数。
 */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

/** 工具定义 */
export interface Tool {
  /** 工具名称（唯一标识，传给 LLM） */
  name: string;
  /** 工具描述（传给 LLM，让它知道何时使用） */
  description: string;
  /** 参数的 JSON Schema（传给 LLM，让它知道怎么调用） */
  inputSchema: Record<string, unknown>;
  /** 执行函数 */
  execute: (
    params: Record<string, unknown>,
    context?: ToolContext,
  ) => Promise<ToolResult>;
}

/** 传给 LLM 的工具定义（不含 execute） */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
