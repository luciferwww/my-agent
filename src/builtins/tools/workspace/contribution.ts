import type { ExtensionRegistrationApi, RuntimeContributionUnit } from '../../../core/registry/index.js';
import { createApplyPatchTool } from './filesystem/apply-patch-tool.js';
import { createEditFileTool } from './filesystem/edit-file-tool.js';
import { createListDirTool } from './filesystem/list-dir-tool.js';
import { createReadFileTool } from './filesystem/read-file-tool.js';
import { createWriteFileTool } from './filesystem/write-file-tool.js';
import { createFileSearchTool } from './search/file-search-tool.js';
import { createGrepSearchTool } from './search/grep-search-tool.js';
import { webFetchTool } from './web/web-fetch-tool.js';
import { createExecTool } from './process/exec-tool.js';
import { processTool } from './process/process-tool.js';

export interface WorkspaceToolsContributionOptions {
  readonly workingDir: string;
  readonly fsWorkingDirOnly: boolean;
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
      api.registerTool(createListDirTool(options.workingDir, options.fsWorkingDirOnly));
      api.registerTool(createReadFileTool(options.workingDir, options.fsWorkingDirOnly));
      api.registerTool(createFileSearchTool(options.workingDir));
      api.registerTool(createGrepSearchTool(options.workingDir));
      api.registerTool(createApplyPatchTool(options.workingDir, options.fsWorkingDirOnly));
      api.registerTool(createWriteFileTool(options.workingDir, options.fsWorkingDirOnly));
      api.registerTool(createEditFileTool(options.workingDir, options.fsWorkingDirOnly));
      if (options.webFetchEnabled) api.registerTool(webFetchTool);
      if (options.execEnabled) api.registerTool(createExecTool(options.workingDir));
      if (options.processEnabled) api.registerTool(processTool);
    },
  });
}
