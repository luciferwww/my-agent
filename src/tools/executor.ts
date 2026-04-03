import type { Tool, ToolExecutor, ToolResult, ToolDefinition } from './types.js';

/**
 * 将 Tool[] 转换为 ToolExecutor 回调，供 agent-runner 使用。
 * 按 name 查找工具并执行，异常自动捕获转为 ToolResult。
 */
export function createToolExecutor(tools: Tool[]): ToolExecutor {
  return async (toolName: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        content: `Tool "${toolName}" not found`,
        isError: true,
      };
    }

    try {
      return await tool.execute(input);
    } catch (err) {
      return {
        content: `Error executing tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  };
}

/**
 * 从 Tool[] 提取传给 LLM 的工具定义数组（不含 execute）。
 */
export function getToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
