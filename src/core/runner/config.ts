export interface RunnerConfig {
  readonly maxLlmCalls?: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = Object.freeze({});

export class RunnerConfigValidationError extends Error {
  readonly fieldPath?: string;

  constructor(fieldPath?: string) {
    super('Runner configuration is invalid.');
    this.name = 'RunnerConfigValidationError';
    this.fieldPath = fieldPath;
  }
}

export function validateRunnerConfig(
  value: unknown,
): asserts value is Partial<RunnerConfig> {
  if (!isPlainObject(value)) {
    throw new RunnerConfigValidationError();
  }

  for (const field of Object.keys(value)) {
    if (field !== 'maxLlmCalls') {
      throw new RunnerConfigValidationError(field);
    }
  }

  const maxLlmCalls = value['maxLlmCalls'];
  if (
    maxLlmCalls !== undefined
    && (!Number.isInteger(maxLlmCalls) || (maxLlmCalls as number) <= 0)
  ) {
    throw new RunnerConfigValidationError('maxLlmCalls');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
