import type { ChatToolDefinition } from '../adapters/llm/types.js';
import type { MemoryManager } from '../core/memory/MemoryManager.js';
import { createMemoryTools } from '../core/memory/memory-tools.js';
import type { ToolDefinition as PromptToolDefinition } from '../core/prompt/types.js';
import {
  createApplyPatchTool,
  createEditFileTool,
  createFileSearchTool,
  createGrepSearchTool,
  createListDirTool,
  createReadFileTool,
  createToolExecutor,
  createWriteFileTool,
  execTool,
  getToolDefinitions,
  processTool,
  webFetchTool,
} from '../core/tools/index.js';
import type { Tool } from '../core/tools/types.js';
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
  const { workspaceDir, fsWorkspaceOnly = true } = options;

  const tools: Tool[] = [
    createListDirTool(workspaceDir, fsWorkspaceOnly),
    createReadFileTool(workspaceDir, fsWorkspaceOnly),
    createFileSearchTool(workspaceDir),
    createGrepSearchTool(workspaceDir),
    createApplyPatchTool(workspaceDir, fsWorkspaceOnly),
    createWriteFileTool(workspaceDir, fsWorkspaceOnly),
    createEditFileTool(workspaceDir, fsWorkspaceOnly),
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