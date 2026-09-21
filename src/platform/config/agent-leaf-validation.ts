import {
  RuntimeConfigValidationError,
  validateRuntimeConfig,
} from '../../runtime/config.js';
import {
  RunnerConfigValidationError,
  validateRunnerConfig,
} from '../../core/runner/config.js';
import { invalidAgentConfigField } from './agent-config-errors.js';

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

function joinFieldPath(parent: string, field: string): string {
  return parent.length === 0 ? field : `${parent}.${field}`;
}

function validateLeaf<TError extends Error & { readonly fieldPath?: string }>(
  value: unknown,
  fieldPath: string,
  validate: (candidate: unknown) => void,
  ErrorType: new (...args: never[]) => TError,
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
