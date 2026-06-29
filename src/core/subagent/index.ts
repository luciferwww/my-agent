// Public surface of the subagent module.
//
// Subagent runtime wiring lives in `src/runtime/subagent-orchestration.ts`
// (see spec §6.4 dependency direction). This package only exports types,
// session-key helpers, and capability resolution.

export type {
  SubagentProfile,
  SubagentRole,
  SubagentCapabilities,
  RunTrigger,
  RunLifecycle,
  SubagentRunInput,
  SubagentRunResult,
  SubagentHostBindings,
  SubagentRunnerDeps,
  SubagentRunRequest,
} from './types.js';

export {
  formatSubagentSessionKey,
  isSubagentSessionKey,
  getSubagentDepth,
  parseSubagentSessionKey,
} from './session-key.js';
export type { ParsedSubagentKey } from './session-key.js';

export { resolveSubagentCapabilities } from './capabilities.js';

export { loadSubagentProfiles, buildGeneralPurposeProfile } from './config-loader.js';

export { resolveSubagentTools } from './profile-tools.js';
export type { ResolvedSubagentTools } from './profile-tools.js';
