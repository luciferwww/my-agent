// Public surface of the subagent module.
//
// Subagent runtime wiring lives in `src/runtime/subagent-orchestration.ts`
// (see spec §6.4 dependency direction). This package only exports types,
// configuration, prompt helpers, and capability resolution.

export type {
  SubagentProfile,
  SubagentRole,
  SubagentCapabilities,
  SubagentDelegationRequest,
  SubagentDelegationPort,
  SubagentTerminalFailure,
  SubagentTerminalResult,
} from './types.js';

export { resolveSubagentCapabilities } from './capabilities.js';

export { loadSubagentProfiles, buildGeneralPurposeProfile } from './config-loader.js';

export { resolveSubagentTools } from './profile-tools.js';
export type { ResolvedSubagentTools } from './profile-tools.js';

export { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';
export type { BehavioralAddendumOpts } from './behavioral-addendum.js';

export {
  collectAvailableSubagents,
  renderAvailableSubagentsSection,
} from './available-subagents.js';
export type { AvailableSubagentEntry } from './available-subagents.js';
