export interface ToolPolicyConfig {
  readonly allow?: string[];
  readonly deny?: string[];
}

export const DEFAULT_TOOL_POLICY_CONFIG: Readonly<ToolPolicyConfig> = deepFreeze({
  allow: [],
  deny: [],
});

export class ToolPolicyConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Tool policy configuration is invalid.');
    this.name = 'ToolPolicyConfigValidationError';
  }
}

export function validateToolPolicyConfig(value: unknown): asserts value is Partial<ToolPolicyConfig> {
  if (!isObject(value)) throw new ToolPolicyConfigValidationError();
  for (const field of Object.keys(value)) {
    if (field !== 'allow' && field !== 'deny') {
      throw new ToolPolicyConfigValidationError(field);
    }
  }
  for (const field of ['allow', 'deny'] as const) {
    const patterns = value[field];
    if (
      patterns !== undefined
      && (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string'))
    ) {
      throw new ToolPolicyConfigValidationError(field);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
