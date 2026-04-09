import type { AgentDefaults } from '../config/types.js';
import type { ToolDefinition as PromptToolDefinition, SystemPromptBuildParams } from '../prompt-builder/types/builder.js';
import type { ContextFile } from '../workspace/types.js';
import type { RunTurnParams } from './types.js';

export interface BuildSystemPromptParamsInput {
  config: AgentDefaults;
  contextFiles: ContextFile[];
  promptDefinitions: PromptToolDefinition[];
  overrides?: Pick<RunTurnParams, 'promptMode' | 'safetyLevel'>;
}

export function buildSystemPromptParams(
  input: BuildSystemPromptParamsInput,
): SystemPromptBuildParams {
  return {
    mode: input.overrides?.promptMode ?? input.config.prompt.mode,
    safetyLevel: input.overrides?.safetyLevel ?? input.config.prompt.safetyLevel,
    contextFiles: input.contextFiles,
    tools: input.promptDefinitions,
  };
}

export function resolveContextLoadMode(promptMode: AgentDefaults['prompt']['mode']): 'full' | 'minimal' {
  // Even when prompt mode is none, Runtime keeps a warm context cache so later reloads or overrides
  // do not need a separate bootstrap path.
  return promptMode === 'minimal' ? 'minimal' : 'full';
}