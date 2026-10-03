export type EmbeddingProviderType = 'local' | 'openai';

export interface EmbeddingConfig {
  readonly provider: EmbeddingProviderType;
  readonly model: string;
}

export interface ChunkingConfig {
  readonly chunkChars: number;
  readonly overlapChars: number;
}

export interface MemorySearchConfig {
  readonly maxResults: number;
  readonly minScore: number;
  readonly vectorWeight: number;
  readonly textWeight: number;
}

export interface MemoryConfig {
  readonly enabled: boolean;
  readonly embedding: EmbeddingConfig;
  readonly chunking: ChunkingConfig;
  readonly search: MemorySearchConfig;
}

export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = deepFreeze({
  enabled: true,
  embedding: {
    provider: 'local',
    model: 'Xenova/all-MiniLM-L6-v2',
  },
  chunking: {
    chunkChars: 1600,
    overlapChars: 320,
  },
  search: {
    maxResults: 6,
    minScore: 0.25,
    vectorWeight: 0.7,
    textWeight: 0.3,
  },
});

export class MemoryConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Memory configuration is invalid.');
    this.name = 'MemoryConfigValidationError';
  }
}

export function validateMemoryConfig(value: unknown): asserts value is Partial<MemoryConfig> {
  if (!isObject(value)) throw new MemoryConfigValidationError();
  rejectUnknownFields(value, ['enabled', 'embedding', 'chunking', 'search']);
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    throw new MemoryConfigValidationError('enabled');
  }
  validateEmbedding(value['embedding']);
  validateChunking(value['chunking']);
  validateSearch(value['search']);
}

function validateEmbedding(value: unknown): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new MemoryConfigValidationError('embedding');
  rejectUnknownFields(value, ['provider', 'model'], 'embedding');
  if (
    value['provider'] !== undefined
    && value['provider'] !== 'local'
    && value['provider'] !== 'openai'
  ) {
    throw new MemoryConfigValidationError('embedding.provider');
  }
  if (
    value['model'] !== undefined
    && (typeof value['model'] !== 'string' || value['model'].trim().length === 0)
  ) {
    throw new MemoryConfigValidationError('embedding.model');
  }
}

function validateChunking(value: unknown): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new MemoryConfigValidationError('chunking');
  rejectUnknownFields(value, ['chunkChars', 'overlapChars'], 'chunking');
  const chunkChars = value['chunkChars'];
  const overlapChars = value['overlapChars'];
  if (chunkChars !== undefined && !isPositiveSafeInteger(chunkChars)) {
    throw new MemoryConfigValidationError('chunking.chunkChars');
  }
  if (overlapChars !== undefined && !isPositiveSafeInteger(overlapChars)) {
    throw new MemoryConfigValidationError('chunking.overlapChars');
  }
  if (
    chunkChars !== undefined
    && overlapChars !== undefined
    && (overlapChars as number) >= (chunkChars as number)
  ) {
    throw new MemoryConfigValidationError('chunking.overlapChars');
  }
}

function validateSearch(value: unknown): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new MemoryConfigValidationError('search');
  rejectUnknownFields(
    value,
    ['maxResults', 'minScore', 'vectorWeight', 'textWeight'],
    'search',
  );
  if (value['maxResults'] !== undefined && !isPositiveSafeInteger(value['maxResults'])) {
    throw new MemoryConfigValidationError('search.maxResults');
  }
  for (const field of ['minScore', 'vectorWeight', 'textWeight'] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined
      && (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 1)
    ) {
      throw new MemoryConfigValidationError(`search.${field}`);
    }
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function rejectUnknownFields(
  value: object,
  allowed: readonly string[],
  parent?: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new MemoryConfigValidationError(parent === undefined ? field : `${parent}.${field}`);
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
