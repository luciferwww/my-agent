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
import { createTaskTool, type TaskToolDeps } from '../core/tools/builtin/task/index.js';
import type { Tool } from '../core/tools/types.js';
import { matchesAny } from './glob-match.js';
import type { RuntimeBuiltinToolOptions, RuntimeToolBundle } from './types.js';

/**
 * 按 deny 列表过滤工具。spec §5.2：注册时一次性应用。
 *
 * 注册入口约定（spec §5.2）：
 * 凡是把工具注入运行时 toolBundle 的代码路径，**都必须在自己的注入点调一次 applyDenyFilter**。
 * 不能依赖 assembleRuntimeTools 里那一次过滤——那是启动时的一次性调用，
 * 运行时后动态注入的工具不会被重复过滤。
 *
 * 当前入口：
 *   - bootstrap.ts → assembleRuntimeTools (builtin + memory tools)
 * 未来入口（接入时必须调 applyDenyFilter）：
 *   - MCP server 连上后注入工具——在 MCP 适配层自己调一次后再 push 进 toolBundle
 *   - 用户自定义动态工具注册 API——同上
 */
export function applyDenyFilter(tools: Tool[], deny: readonly string[]): Tool[] {
  if (deny.length === 0) return tools;
  return tools.filter((t) => !matchesAny(t.name, deny));
}

export interface AssembleRuntimeToolsParams {
  builtinTools: Tool[];
  memoryManager: MemoryManager | null;
  /** 来自 resolvedConfig.tools.deny ?? []。空数组表示「不过滤」是合法值。 */
  deny: readonly string[];
}

export function assembleRuntimeTools(params: AssembleRuntimeToolsParams): RuntimeToolBundle {
  let tools = [...params.builtinTools];

  if (params.memoryManager) {
    tools.push(...createMemoryTools(params.memoryManager));
  }

  // 过滤在 memory tools 加入之后做——这样 deny:['memory_*'] 能命中 memory 工具
  tools = applyDenyFilter(tools, params.deny);

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

/**
 * Parameters for {@link buildTaskToolIfEnabled}: the same dependency set
 * `createTaskTool` needs, plus a runtime `enabled` flag.
 */
export interface BuildTaskToolParams extends TaskToolDeps {
  /** When `false`, `task` is not registered (e.g. `subagents.enabled === false`). */
  enabled: boolean;
}

/**
 * Build the LLM-facing `task` tool, or return `null` when subagents are
 * disabled. Sugar over `createTaskTool(deps)`; lets the caller stay free
 * of a manual `if (enabled)` guard.
 */
export function buildTaskToolIfEnabled(params: BuildTaskToolParams): Tool | null {
  if (!params.enabled) return null;
  const { enabled: _enabled, ...deps } = params;
  return createTaskTool(deps);
}