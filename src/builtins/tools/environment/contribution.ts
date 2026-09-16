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

export interface EnvironmentContributionOptions {
  readonly agentHome: string;
  readonly webFetchEnabled: boolean;
  readonly execEnabled: boolean;
  readonly processEnabled: boolean;
}

export function createEnvironmentContribution(
  options: EnvironmentContributionOptions,
): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-environment',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerTool(createListDirTool(options.agentHome));
      api.registerTool(createReadFileTool(options.agentHome));
      api.registerTool(createFileSearchTool(options.agentHome));
      api.registerTool(createGrepSearchTool(options.agentHome));
      api.registerTool(createApplyPatchTool(options.agentHome));
      api.registerTool(createWriteFileTool(options.agentHome));
      api.registerTool(createEditFileTool(options.agentHome));
      if (options.webFetchEnabled) api.registerTool(webFetchTool);
      if (options.execEnabled) api.registerTool(createExecTool(options.agentHome));
      if (options.processEnabled) api.registerTool(processTool);
    },
  });
}
