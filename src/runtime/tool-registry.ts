import type { ChatToolDefinition } from '../llm-client/types.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import { createMemoryTools } from '../memory/tools/memory-tools.js';
import type { ToolDefinition as PromptToolDefinition } from '../prompt-builder/types/builder.js';
import {
  applyPatchTool,
  createToolExecutor,
  editFileTool,
  execTool,
  fileSearchTool,
  getToolDefinitions,
  grepSearchTool,
  listDirTool,
  processTool,
  readFileTool,
  webFetchTool,
  writeFileTool,
} from '../tools/index.js';
import type { Tool } from '../tools/types.js';
import type { RuntimeBuiltinToolOptions, RuntimeToolBundle } from './types.js';

export interface AssembleRuntimeToolsParams {
  builtinTools: Tool[];
  memoryManager: MemoryManager | null;
}

export function assembleRuntimeTools(params: AssembleRuntimeToolsParams): RuntimeToolBundle {
  const tools = [...params.builtinTools];

  if (params.memoryManager) {
    tools.push(...createMemoryTools(params.memoryManager));
  }

  return {
    tools,
    executor: createToolExecutor(tools),
    llmDefinitions: toLlmToolDefinitions(tools),
    promptDefinitions: toPromptToolDefinitions(tools),
  };
}

export function getDefaultBuiltinTools(options: RuntimeBuiltinToolOptions): Tool[] {
  const tools: Tool[] = [
    listDirTool,
    readFileTool,
    fileSearchTool,
    grepSearchTool,
    applyPatchTool,
    writeFileTool,
    editFileTool,
  ];

  if (options.webFetchEnabled !== false) {
    tools.push(webFetchTool);
  }

  if (options.execEnabled !== false) {
    tools.push(execTool);
  }

  if (options.processEnabled !== false) {
    tools.push(processTool);
  }

  return tools;
}

export function toPromptToolDefinitions(tools: Tool[]): PromptToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function toLlmToolDefinitions(tools: Tool[]): ChatToolDefinition[] {
  return getToolDefinitions(tools);
}