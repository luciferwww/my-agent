export const DEFAULT_SKILLS: readonly string[] = Object.freeze([]);

export function isSkillName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1 && value.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

export class SkillSelectionValidationError extends Error {
  constructor() {
    super('Skills must be a list of unique valid Skill names.');
    this.name = 'SkillSelectionValidationError';
  }
}

export function validateSkillSelection(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || !value.every(isSkillName) || new Set(value).size !== value.length) {
    throw new SkillSelectionValidationError();
  }
}
