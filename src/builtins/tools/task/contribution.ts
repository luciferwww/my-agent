import type { ExtensionRegistrationApi, RuntimeContributionUnit } from '../../../core/registry/index.js';
import { createTaskTool, type TaskToolDeps } from './task-tool.js';

export function createTaskToolContribution(deps: TaskToolDeps): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-subagent-tools',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) {
      api.registerTool(createTaskTool(deps));
    },
  });
}
