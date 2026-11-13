import type { SystemPromptBuildParams } from '../core/prompt/types.js';
import type { ContextFile } from '../core/agent-context/types.js';
import type { AvailableSubagentEntry } from '../core/subagent/available-subagents.js';
import type { RunTurnParams } from './types.js';
import type { SkillSummary } from '../core/skills/index.js';

export interface BuildSystemPromptParamsInput {
  contextFiles: ContextFile[];
  toolNames: readonly string[];
  overrides: Pick<RunTurnParams, 'promptMode'>;
  /** Agent Home absolute path injected by RuntimeApp for the prompt path section. */
  agentHome?: string;
  /**
   * Entries for the `<available-subagents>` section (spec §11 Section 8).
   * RuntimeApp supplies them only when the `task` Tool is visible to the current Agent.
   */
  availableSubagents?: AvailableSubagentEntry[];
  availableSkills?: readonly SkillSummary[];
}

export function buildSystemPromptParams(
  input: BuildSystemPromptParamsInput,
): SystemPromptBuildParams {
  return {
    mode: input.overrides.promptMode,
    contextFiles: input.contextFiles,
    toolNames: input.toolNames,
    agentHome: input.agentHome,
    availableSubagents: input.availableSubagents,
    availableSkills: input.availableSkills,
  };
}

export function resolveContextLoadMode(promptMode: 'full' | 'minimal' | 'none'): 'full' | 'minimal' {
  // Even when prompt mode is none, Runtime keeps a warm context cache so later reloads or overrides
  // do not need a separate bootstrap path.
  return promptMode === 'minimal' ? 'minimal' : 'full';
}