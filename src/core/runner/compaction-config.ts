export interface CompactionConfig {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTurns: number;
  readonly toolResultContextShare: number;
  readonly toolResultHeadChars: number;
  readonly toolResultTailChars: number;
  readonly timeoutSeconds: number;
  readonly customInstructions?: string;
}

export const DEFAULT_COMPACTION_CONFIG: Readonly<CompactionConfig> = Object.freeze({
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTurns: 3,
  toolResultContextShare: 0.5,
  toolResultHeadChars: 10_000,
  toolResultTailChars: 5_000,
  timeoutSeconds: 300,
});

export class CompactionConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Compaction configuration is invalid.');
    this.name = 'CompactionConfigValidationError';
  }
}

export function validateCompactionConfig(value: unknown): asserts value is Partial<CompactionConfig> {
  if (!isObject(value)) throw new CompactionConfigValidationError();
  const allowedFields = [
    'enabled',
    'reserveTokens',
    'keepRecentTurns',
    'toolResultContextShare',
    'toolResultHeadChars',
    'toolResultTailChars',
    'timeoutSeconds',
    'customInstructions',
  ];
  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) throw new CompactionConfigValidationError(field);
  }
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    throw new CompactionConfigValidationError('enabled');
  }
  for (const field of ['reserveTokens', 'keepRecentTurns', 'toolResultHeadChars', 'toolResultTailChars'] as const) {
    const candidate = value[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || (candidate as number) < 0)) {
      throw new CompactionConfigValidationError(field);
    }
  }
  if (
    value['timeoutSeconds'] !== undefined
    && (!Number.isSafeInteger(value['timeoutSeconds']) || (value['timeoutSeconds'] as number) <= 0)
  ) {
    throw new CompactionConfigValidationError('timeoutSeconds');
  }
  const share = value['toolResultContextShare'];
  if (share !== undefined && (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 1)) {
    throw new CompactionConfigValidationError('toolResultContextShare');
  }
  if (value['customInstructions'] !== undefined && typeof value['customInstructions'] !== 'string') {
    throw new CompactionConfigValidationError('customInstructions');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
