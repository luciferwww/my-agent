export interface RunnerConfig {
  readonly steeringEnabled: boolean;
  readonly maxLlmCallsPerTurn?: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = Object.freeze({
  steeringEnabled: false,
});

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
    if (field !== 'steeringEnabled' && field !== 'maxLlmCallsPerTurn') {
      throw new RunnerConfigValidationError(field);
    }
  }

  if (
    value['steeringEnabled'] !== undefined
    && typeof value['steeringEnabled'] !== 'boolean'
  ) {
    throw new RunnerConfigValidationError('steeringEnabled');
  }

  const maxLlmCallsPerTurn = value['maxLlmCallsPerTurn'];
  if (
    maxLlmCallsPerTurn !== undefined
    && (
      !Number.isSafeInteger(maxLlmCallsPerTurn)
      || (maxLlmCallsPerTurn as number) <= 0
    )
  ) {
    throw new RunnerConfigValidationError('maxLlmCallsPerTurn');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
