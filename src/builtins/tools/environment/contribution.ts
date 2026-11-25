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
import type { CommandRunner } from './process/exec-types.js';
import type { SandboxConfig } from './process/sandbox/config.js';
import { createFilesystemPolicy } from './common/filesystem-policy.js';

export interface EnvironmentContributionOptions {
  readonly agentHome: string;
  readonly webFetchEnabled: boolean;
  readonly execEnabled: boolean;
  readonly processEnabled: boolean;
  readonly commandRunner?: CommandRunner;
  readonly sandbox?: SandboxConfig;
  readonly dependencyReads?: readonly string[];
}

export function createEnvironmentContribution(
  options: EnvironmentContributionOptions,
): RuntimeContributionUnit {
  const policy = createFilesystemPolicy(options.sandbox, options.dependencyReads);
  return Object.freeze({
    id: 'builtin-environment',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerTool(createListDirTool(options.agentHome, policy));
      api.registerTool(createReadFileTool(options.agentHome, policy));
      api.registerTool(createFileSearchTool(options.agentHome, policy));
      api.registerTool(createGrepSearchTool(options.agentHome, policy));
      api.registerTool(createApplyPatchTool(options.agentHome, policy));
      api.registerTool(createWriteFileTool(options.agentHome, policy));
      api.registerTool(createEditFileTool(options.agentHome, policy));
      if (options.webFetchEnabled) api.registerTool(webFetchTool);
      if (options.execEnabled) api.registerTool(createExecTool(options.agentHome, options.commandRunner));
      if (options.processEnabled) api.registerTool(processTool);
    },
  });
}
