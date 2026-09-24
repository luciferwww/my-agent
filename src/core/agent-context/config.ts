export interface AgentContextConfig {
  readonly maxFileChars: number;
  readonly maxTotalChars: number;
}

export const DEFAULT_AGENT_CONTEXT_CONFIG: Readonly<AgentContextConfig> = Object.freeze({
  maxFileChars: 20_000,
  maxTotalChars: 150_000,
});

export class AgentContextConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Agent Context configuration is invalid.');
    this.name = 'AgentContextConfigValidationError';
  }
}

export function validateAgentContextConfig(value: unknown): asserts value is Partial<AgentContextConfig> {
  if (!isObject(value)) throw new AgentContextConfigValidationError();
  for (const field of Object.keys(value)) {
    if (field !== 'maxFileChars' && field !== 'maxTotalChars') {
      throw new AgentContextConfigValidationError(field);
    }
  }
  for (const field of ['maxFileChars', 'maxTotalChars'] as const) {
    const candidate = value[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || (candidate as number) <= 0)) {
      throw new AgentContextConfigValidationError(field);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
