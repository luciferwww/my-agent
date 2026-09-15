import type { ExtensionRegistrationApi, RuntimeContributionUnit } from '../../../core/registry/index.js';
import { createApplyPatchTool } from './filesystem/apply-patch-tool.js';
import { createEditFileTool } from './filesystem/edit-file-tool.js';
import { createListDirTool } from './filesystem/list-dir-tool.js';
import { createReadFileTool } from './filesystem/read-file-tool.js';
import { createWriteFileTool } from './filesystem/write-file-tool.js';
import { createFileSearchTool } from './search/file-search-tool.js';
import { createGrepSearchTool } from './search/grep-search-tool.js';
import { webFetchTool } from './web/web-fetch-tool.js';
import { execTool } from './process/exec-tool.js';
import { processTool } from './process/process-tool.js';

export interface WorkspaceToolsContributionOptions {
  readonly workspaceDir: string;
  readonly fsWorkspaceOnly: boolean;
  readonly webFetchEnabled: boolean;
  readonly execEnabled: boolean;
  readonly processEnabled: boolean;
}

export function createWorkspaceToolsContribution(
  options: WorkspaceToolsContributionOptions,
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
