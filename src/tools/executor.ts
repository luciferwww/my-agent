import type { Tool, ToolExecutor, ToolResult, ToolDefinition } from './types.js';

/**
 * Convert Tool[] into a ToolExecutor callback for agent-runner.
 * Tools are resolved by name, and thrown errors are converted into ToolResult.
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
 * Extract the LLM-facing tool definitions from Tool[] without execute handlers.
 */
export function getToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
