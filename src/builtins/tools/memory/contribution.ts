import type { MemoryManager } from '../../../core/memory/MemoryManager.js';
import type { ExtensionRegistrationApi, RuntimeContributionUnit } from '../../../core/registry/index.js';
import { createMemoryTools } from './memory-tools.js';

export function createMemoryToolsContribution(
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
