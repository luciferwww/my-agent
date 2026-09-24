import type { ModelReference } from '../model-resolution/index.js';

export type SubagentModelSelection = 'inherit' | ModelReference;

export interface SubagentToolsConfig {
  readonly allow?: string[];
  readonly deny?: string[];
}

export interface SubagentConfigEntry {
  readonly id: string;
  readonly description: string;
  readonly model: SubagentModelSelection;
  readonly maxLlmCalls?: number;
  readonly tools?: SubagentToolsConfig;
}

export interface SubagentConfig {
  readonly enabled: boolean;
  readonly maxDepth: number;
  readonly list?: SubagentConfigEntry[];
}

export const DEFAULT_SUBAGENT_CONFIG: Readonly<SubagentConfig> = deepFreeze({
  enabled: true,
  maxDepth: 1,
  list: [],
});

export class SubagentConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Subagent configuration is invalid.');
    this.name = 'SubagentConfigValidationError';
  }
}

export function validateSubagentConfig(value: unknown): asserts value is Partial<SubagentConfig> {
  if (!isObject(value)) throw new SubagentConfigValidationError();
  rejectUnknownFields(value, ['enabled', 'maxDepth', 'list'], '');
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    throw new SubagentConfigValidationError('enabled');
  }
  if (
    value['maxDepth'] !== undefined
    && (!Number.isSafeInteger(value['maxDepth']) || (value['maxDepth'] as number) < 0)
  ) {
    throw new SubagentConfigValidationError('maxDepth');
  }
  const list = value['list'];
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new SubagentConfigValidationError('list');
  const ids = new Set<string>();
  list.forEach((entry, index) => {
    const path = `list[${index}]`;
    if (!isObject(entry)) throw new SubagentConfigValidationError(path);
    rejectUnknownFields(entry, ['id', 'description', 'model', 'maxLlmCalls', 'tools'], path);
    const id = entry['id'];
    if (typeof id !== 'string' || id.trim().length === 0 || ids.has(id)) {
      throw new SubagentConfigValidationError(`${path}.id`);
    }
    ids.add(id);
    if (typeof entry['description'] !== 'string' || entry['description'].trim().length === 0) {
      throw new SubagentConfigValidationError(`${path}.description`);
    }
    const model = entry['model'];
    if (model !== 'inherit' && !isModelReference(model)) {
      throw new SubagentConfigValidationError(`${path}.model`);
    }
    if (model !== 'inherit') {
      rejectUnknownFields(model, ['providerId', 'modelId'], `${path}.model`);
    }
    if (
      entry['maxLlmCalls'] !== undefined
      && (!Number.isSafeInteger(entry['maxLlmCalls']) || (entry['maxLlmCalls'] as number) <= 0)
    ) {
      throw new SubagentConfigValidationError(`${path}.maxLlmCalls`);
    }
    validateTools(entry['tools'], `${path}.tools`);
  });
}

function validateTools(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new SubagentConfigValidationError(path);
  rejectUnknownFields(value, ['allow', 'deny'], path);
  for (const field of ['allow', 'deny'] as const) {
    const patterns = value[field];
    if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some((item) => typeof item !== 'string'))) {
      throw new SubagentConfigValidationError(`${path}.${field}`);
    }
  }
}

function isModelReference(value: unknown): value is ModelReference {
  return isObject(value)
    && typeof value['providerId'] === 'string'
    && value['providerId'].trim().length > 0
    && typeof value['modelId'] === 'string'
    && value['modelId'].trim().length > 0;
}

function rejectUnknownFields(
  value: object,
  allowed: readonly string[],
  parent: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new SubagentConfigValidationError(parent.length === 0 ? field : `${parent}.${field}`);
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
