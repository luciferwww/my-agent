import {
  RuntimeConfigValidationError,
  validateRuntimeConfig,
} from '../../runtime/config.js';
import {
  RunnerConfigValidationError,
  validateRunnerConfig,
} from '../../core/runner/config.js';
import { invalidAgentConfigField } from './agent-config-errors.js';
import {
  MemoryConfigValidationError,
  validateMemoryConfig,
} from '../../core/memory/index.js';
import {
  PromptConfigValidationError,
  validatePromptConfig,
} from '../../core/prompt/index.js';
import {
  ToolPolicyConfigValidationError,
  validateToolPolicyConfig,
} from '../../core/tools/index.js';
import {
  AgentContextConfigValidationError,
  validateAgentContextConfig,
} from '../../core/agent-context/index.js';
import {
  CompactionConfigValidationError,
  validateCompactionConfig,
} from '../../core/runner/index.js';
import {
  SubagentConfigValidationError,
  validateSubagentConfig,
} from '../../core/subagent/index.js';

export function validateRuntimeAndRunnerConfig(
  value: Readonly<Record<string, unknown>>,
  fieldPath: string,
): void {
  validateLeaf(
    value['runtime'],
    joinFieldPath(fieldPath, 'runtime'),
    validateRuntimeConfig,
    RuntimeConfigValidationError,
  );
  validateLeaf(
    value['runner'],
    joinFieldPath(fieldPath, 'runner'),
    validateRunnerConfig,
    RunnerConfigValidationError,
  );
}

export function validateAgentLeafConfig(
  value: object,
  fieldPath: string,
): void {
  const leaves = value as Readonly<Record<string, unknown>>;
  validateLeaf(leaves['memory'], joinFieldPath(fieldPath, 'memory'), validateMemoryConfig, MemoryConfigValidationError);
  validateLeaf(leaves['prompt'], joinFieldPath(fieldPath, 'prompt'), validatePromptConfig, PromptConfigValidationError);
  validateLeaf(leaves['tools'], joinFieldPath(fieldPath, 'tools'), validateToolPolicyConfig, ToolPolicyConfigValidationError);
  validateLeaf(leaves['context'], joinFieldPath(fieldPath, 'context'), validateAgentContextConfig, AgentContextConfigValidationError);
  validateLeaf(leaves['compaction'], joinFieldPath(fieldPath, 'compaction'), validateCompactionConfig, CompactionConfigValidationError);
  validateLeaf(leaves['subagents'], joinFieldPath(fieldPath, 'subagents'), validateSubagentConfig, SubagentConfigValidationError);
}

function joinFieldPath(parent: string, field: string): string {
  return parent.length === 0 ? field : `${parent}.${field}`;
}

function validateLeaf<TError extends Error & { readonly fieldPath?: string }>(
  value: unknown,
  fieldPath: string,
  validate: (candidate: unknown) => void,
  ErrorType: abstract new (fieldPath?: string) => TError,
): void {
  if (value === undefined) return;
  try {
    validate(value);
  } catch (error) {
    if (!(error instanceof ErrorType)) throw error;
    throw invalidAgentConfigField(
      error.fieldPath === undefined ? fieldPath : `${fieldPath}.${error.fieldPath}`,
    );
  }
}
