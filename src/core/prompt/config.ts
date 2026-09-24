export type SafetyLevel = 'strict' | 'normal' | 'relaxed';

export interface PromptConfig {
  readonly safetyLevel: SafetyLevel;
}

export const DEFAULT_PROMPT_CONFIG: Readonly<PromptConfig> = Object.freeze({
  safetyLevel: 'normal',
});

export class PromptConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Prompt configuration is invalid.');
    this.name = 'PromptConfigValidationError';
  }
}

export function validatePromptConfig(value: unknown): asserts value is Partial<PromptConfig> {
  if (!isObject(value)) throw new PromptConfigValidationError();
  for (const field of Object.keys(value)) {
    if (field !== 'safetyLevel') throw new PromptConfigValidationError(field);
  }
  const level = value['safetyLevel'];
  if (level !== undefined && level !== 'strict' && level !== 'normal' && level !== 'relaxed') {
    throw new PromptConfigValidationError('safetyLevel');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
