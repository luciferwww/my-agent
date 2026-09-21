export interface RuntimeConfig {
  readonly steeringEnabled: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  steeringEnabled: false,
});

export class RuntimeConfigValidationError extends Error {
  readonly fieldPath?: string;

  constructor(fieldPath?: string) {
    super('Runtime configuration is invalid.');
    this.name = 'RuntimeConfigValidationError';
    this.fieldPath = fieldPath;
  }
}

export function validateRuntimeConfig(
  value: unknown,
): asserts value is Partial<RuntimeConfig> {
  if (!isPlainObject(value)) {
    throw new RuntimeConfigValidationError();
  }

  for (const field of Object.keys(value)) {
    if (field !== 'steeringEnabled') {
      throw new RuntimeConfigValidationError(field);
    }
  }

  if (
    value['steeringEnabled'] !== undefined
    && typeof value['steeringEnabled'] !== 'boolean'
  ) {
    throw new RuntimeConfigValidationError('steeringEnabled');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
