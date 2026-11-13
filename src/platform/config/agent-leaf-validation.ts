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
import { createDefaultAgentConfig } from './default-composition.js';
import type { AgentDefaults, DeepPartial } from './types.js';
import { validateSkillSelection, SkillSelectionValidationError } from '../../core/skills/index.js';

export function projectAgentCapabilities(value: unknown, fieldPath: string): DeepPartial<AgentDefaults> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidAgentConfigField(fieldPath);
  }
  const defaults = createDefaultAgentConfig();
  const supported = projectSupportedFields(value, {
    ...defaults,
    compaction: { ...defaults.compaction, customInstructions: '' },
  });
  validateAgentLeafConfig(supported, fieldPath);
  return supported as DeepPartial<AgentDefaults>;
}

function projectSupportedFields(value: object, template: object): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(template).flatMap(([key, shape]) => {
    if (!Object.hasOwn(source, key)) return [];
    const candidate = source[key];
    return [[key, typeof shape === 'object' && shape !== null && !Array.isArray(shape)
      && typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? projectSupportedFields(candidate, shape)
      : candidate]];
  }));
}

export function validateRunnerConfigSection(
  value: unknown,
  fieldPath: string,
): void {
  validateLeaf(value, fieldPath, validateRunnerConfig, RunnerConfigValidationError);
}

export function validateAgentLeafConfig(
  value: object,
  fieldPath: string,
): void {
  const leaves = value as Readonly<Record<string, unknown>>;
  validateLeaf(leaves['memory'], joinFieldPath(fieldPath, 'memory'), validateMemoryConfig, MemoryConfigValidationError);
  validateLeaf(leaves['tools'], joinFieldPath(fieldPath, 'tools'), validateToolPolicyConfig, ToolPolicyConfigValidationError);
  validateLeaf(leaves['context'], joinFieldPath(fieldPath, 'context'), validateAgentContextConfig, AgentContextConfigValidationError);
  validateLeaf(leaves['compaction'], joinFieldPath(fieldPath, 'compaction'), validateCompactionConfig, CompactionConfigValidationError);
  validateLeaf(leaves['skills'], joinFieldPath(fieldPath, 'skills'), validateSkillSelection, SkillSelectionValidationError);
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
