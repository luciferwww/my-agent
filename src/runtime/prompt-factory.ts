import type { AgentDefaults } from '../platform/config/types.js';
import type { SystemPromptBuildParams } from '../core/prompt/types.js';
import type { ContextFile } from '../core/agent-context/types.js';
import type { AvailableSubagentEntry } from '../core/subagent/available-subagents.js';
import type { RunTurnParams } from './types.js';

export interface BuildSystemPromptParamsInput {
  config: AgentDefaults;
  contextFiles: ContextFile[];
  toolNames: readonly string[];
  overrides: Pick<RunTurnParams, 'promptMode' | 'safetyLevel'>;
  /** Agent Home absolute path injected by RuntimeApp for the prompt path section. */
  agentHome?: string;
  /**
   * `<available-subagents>` section 条目列表（spec §11 Section 8）。
   * RuntimeApp 仅在 `subagents.enabled === true` 时传入；否则不渲染。
   */
  availableSubagents?: AvailableSubagentEntry[];
}

export function buildSystemPromptParams(
  input: BuildSystemPromptParamsInput,
): SystemPromptBuildParams {
  return {
    mode: input.overrides.promptMode,
    safetyLevel: input.overrides.safetyLevel ?? input.config.prompt.safetyLevel,
    contextFiles: input.contextFiles,
    toolNames: input.toolNames,
    agentHome: input.agentHome,
    availableSubagents: input.availableSubagents,
  };
}

export function resolveContextLoadMode(promptMode: 'full' | 'minimal' | 'none'): 'full' | 'minimal' {
  // Even when prompt mode is none, Runtime keeps a warm context cache so later reloads or overrides
  // do not need a separate bootstrap path.
  return promptMode === 'minimal' ? 'minimal' : 'full';
}