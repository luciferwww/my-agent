import type { MemoryManager } from '../core/memory/MemoryManager.js';
import { createMemoryTools } from '../core/memory/memory-tools.js';
import type { ExtensionRegistrationApi, RuntimeContributionUnit } from '../core/registry/index.js';
import {
  createApplyPatchTool,
  createEditFileTool,
  createFileSearchTool,
  createGrepSearchTool,
  createListDirTool,
  createReadFileTool,
  createWriteFileTool,
  execTool,
  processTool,
  webFetchTool,
} from '../core/tools/index.js';
import { createTaskTool, type TaskToolDeps } from '../core/tools/builtin/task/index.js';

export interface WorkspaceToolModuleOptions {
  readonly workspaceDir: string;
  readonly fsWorkspaceOnly: boolean;
  readonly webFetchEnabled: boolean;
  readonly execEnabled: boolean;
  readonly processEnabled: boolean;
}

export function createWorkspaceToolModule(
  options: WorkspaceToolModuleOptions,
): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-workspace-tools',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerTool(createListDirTool(options.workspaceDir, options.fsWorkspaceOnly));
      api.registerTool(createReadFileTool(options.workspaceDir, options.fsWorkspaceOnly));
      api.registerTool(createFileSearchTool(options.workspaceDir));
      api.registerTool(createGrepSearchTool(options.workspaceDir));
      api.registerTool(createApplyPatchTool(options.workspaceDir, options.fsWorkspaceOnly));
      api.registerTool(createWriteFileTool(options.workspaceDir, options.fsWorkspaceOnly));
      api.registerTool(createEditFileTool(options.workspaceDir, options.fsWorkspaceOnly));
      if (options.webFetchEnabled) api.registerTool(webFetchTool);
      if (options.execEnabled) api.registerTool(execTool);
      if (options.processEnabled) api.registerTool(processTool);
    },
  });
}

export function createMemoryToolModule(
  memoryManager: MemoryManager,
): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-memory-tools',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      for (const tool of createMemoryTools(memoryManager)) {
        api.registerTool(tool);
      }
    },
  });
}

export function createTaskToolModule(deps: TaskToolDeps): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-subagent-tools',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerTool(createTaskTool(deps));
    },
  });
}
