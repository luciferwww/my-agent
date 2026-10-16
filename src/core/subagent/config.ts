export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

export class SubagentDepthValidationError extends Error {
  constructor() {
    super('Maximum Subagent depth is invalid.');
    this.name = 'SubagentDepthValidationError';
  }
}

export function validateMaxSubagentDepth(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SubagentDepthValidationError();
  }
}
