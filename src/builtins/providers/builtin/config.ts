import type { ModelReference } from '../../../core/model-resolution/index.js';

export type BuiltinProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat-completions';

export interface BuiltinModelRegistration {
  readonly modelId: string;
  readonly protocol: BuiltinProtocol;
  readonly displayName?: string;
  readonly maximumContextTokens?: number;
  readonly maximumPromptTokens?: number;
  readonly maximumOutputTokens?: number;
}

export interface BuiltinLlmProviderConfig {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly models: readonly BuiltinModelRegistration[];
}

export interface LLMConfig {
  readonly defaultModel?: ModelReference;
  readonly builtin?: BuiltinLlmProviderConfig;
}

export const DEFAULT_BUILTIN_CONTEXT_LIMIT = 32_768;
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4_096;

const SUPPORTED_PROTOCOLS = new Set<BuiltinProtocol>([
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
]);
export class BuiltinLlmConfigError extends Error {
  readonly fieldPath: string;

  constructor(fieldPath: string) {
    super(`Built-in LLM configuration field ${JSON.stringify(fieldPath)} is invalid.`);
    this.name = 'BuiltinLlmConfigError';
    this.fieldPath = fieldPath;
  }
}

export function validateBuiltinLlmProviderConfig(
  value: unknown,
): BuiltinLlmProviderConfig {
  if (!isPlainObject(value)) throw new BuiltinLlmConfigError('');

  const baseURL = normalizeBaseURL(value['baseURL']);
  const models = validateModels(value['models']);
  const rawApiKey = value['apiKey'];
  if (rawApiKey !== undefined && typeof rawApiKey !== 'string') {
    throw new BuiltinLlmConfigError('apiKey');
  }
  const apiKey = typeof rawApiKey === 'string' && rawApiKey.trim().length > 0
    ? rawApiKey
    : undefined;

  return {
    baseURL,
    ...(apiKey === undefined ? {} : { apiKey }),
    models,
  };
}

function normalizeBaseURL(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.trim().includes('?')
    || value.trim().includes('#')
  ) {
    throw new BuiltinLlmConfigError('baseURL');
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BuiltinLlmConfigError('baseURL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new BuiltinLlmConfigError('baseURL');
  }

  return url.href.replace(/\/+$/u, '');
}

function validateModels(value: unknown): readonly BuiltinModelRegistration[] {
  if (!Array.isArray(value)) throw new BuiltinLlmConfigError('models');

  const modelIds = new Set<string>();
  return value.map((entry, index) => {
    const path = `models[${index}]`;
    if (!isPlainObject(entry)) throw new BuiltinLlmConfigError(path);

    const modelId = entry['modelId'];
    if (typeof modelId !== 'string' || modelId.trim().length === 0) {
      throw new BuiltinLlmConfigError(`${path}.modelId`);
    }
    if (modelIds.has(modelId)) throw new BuiltinLlmConfigError(`${path}.modelId`);
    modelIds.add(modelId);

    const protocol = entry['protocol'];
    if (typeof protocol !== 'string' || !SUPPORTED_PROTOCOLS.has(protocol as BuiltinProtocol)) {
      throw new BuiltinLlmConfigError(`${path}.protocol`);
    }

    const displayName = entry['displayName'];
    if (
      displayName !== undefined
      && (typeof displayName !== 'string' || displayName.trim().length === 0)
    ) {
      throw new BuiltinLlmConfigError(`${path}.displayName`);
    }

    const limits = {
      maximumContextTokens: entry['maximumContextTokens'],
      maximumPromptTokens: entry['maximumPromptTokens'],
      maximumOutputTokens: entry['maximumOutputTokens'],
    };
    for (const [field, limit] of Object.entries(limits)) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) <= 0)) {
        throw new BuiltinLlmConfigError(`${path}.${field}`);
      }
    }
    if (
      typeof limits.maximumContextTokens === 'number'
      && typeof limits.maximumPromptTokens === 'number'
      && limits.maximumPromptTokens > limits.maximumContextTokens
    ) {
      throw new BuiltinLlmConfigError(`${path}.maximumPromptTokens`);
    }
    if (
      typeof limits.maximumContextTokens === 'number'
      && typeof limits.maximumOutputTokens === 'number'
      && limits.maximumOutputTokens > limits.maximumContextTokens
    ) {
      throw new BuiltinLlmConfigError(`${path}.maximumOutputTokens`);
    }

    return {
      modelId,
      protocol: protocol as BuiltinProtocol,
      ...(displayName === undefined ? {} : { displayName }),
      ...copyConfiguredLimits(limits),
    };
  });
}

function copyConfiguredLimits(limits: Readonly<Record<string, unknown>>): {
  maximumContextTokens?: number;
  maximumPromptTokens?: number;
  maximumOutputTokens?: number;
} {
  return {
    ...(typeof limits['maximumContextTokens'] === 'number'
      ? { maximumContextTokens: limits['maximumContextTokens'] }
      : {}),
    ...(typeof limits['maximumPromptTokens'] === 'number'
      ? { maximumPromptTokens: limits['maximumPromptTokens'] }
      : {}),
    ...(typeof limits['maximumOutputTokens'] === 'number'
      ? { maximumOutputTokens: limits['maximumOutputTokens'] }
      : {}),
  };
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
