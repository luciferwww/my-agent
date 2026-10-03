import type { ModelReference } from '../../../core/model-resolution/index.js';
import type { ExplicitThinkingEffort } from '../../../core/model-invocation/index.js';
import {
  normalizeReasoningCapabilities,
  ReasoningCapabilitiesValidationError,
  type ReasoningCapabilities,
} from '../../../core/model-resolution/index.js';

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
  readonly outputTokenLimit?: number;
  readonly reasoning?: ReasoningCapabilities;
  readonly anthropicThinking?: AnthropicThinkingAdapter;
}

export type AnthropicThinkingAdapter =
  | { readonly mode: 'adaptive' }
  | {
      readonly mode: 'budget';
      readonly defaultBudgetTokens?: number;
      readonly budgets?: Partial<
        Record<Exclude<ExplicitThinkingEffort, 'none'>, number>
      >;
    };

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
export const MIN_ANTHROPIC_THINKING_BUDGET_TOKENS = 1_024;

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
      outputTokenLimit: entry['outputTokenLimit'],
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

    const reasoningConfig = normalizeBuiltinReasoningConfig({
      protocol: protocol as BuiltinProtocol,
      reasoning: entry['reasoning'],
      anthropicThinking: entry['anthropicThinking'],
      outputTokenLimit: limits.outputTokenLimit,
      maximumOutputTokens: limits.maximumOutputTokens,
    }, index);
    return {
      modelId,
      protocol: protocol as BuiltinProtocol,
      ...(displayName === undefined ? {} : { displayName }),
      ...copyConfiguredLimits(limits),
      ...reasoningConfig,
    };
  });
}

export function normalizeBuiltinReasoningConfig(
  model: {
    readonly protocol: BuiltinProtocol;
    readonly reasoning?: unknown;
    readonly anthropicThinking?: unknown;
    readonly outputTokenLimit?: unknown;
    readonly maximumOutputTokens?: unknown;
  },
  index: number,
): Pick<
  BuiltinModelRegistration,
  'reasoning' | 'anthropicThinking'
> {
  const path = `models[${index}]`;
  const reasoning = validateReasoningCapabilities(model.reasoning, path);

  const anthropicThinking = validateAnthropicThinkingAdapter(
    model.anthropicThinking,
    path,
  );
  if (anthropicThinking !== undefined && model.protocol !== 'anthropic-messages') {
    throw new BuiltinLlmConfigError(`${path}.anthropicThinking`);
  }

  const thinking = reasoning?.thinking ?? [];
  const efforts = reasoning?.efforts ?? [];
  if (
    model.protocol === 'anthropic-messages'
    && (thinking.length > 0 || efforts.length > 0)
    && anthropicThinking === undefined
  ) {
    throw new BuiltinLlmConfigError(`${path}.anthropicThinking`);
  }

  if (anthropicThinking?.mode === 'budget') {
    if (thinking.includes('on') && anthropicThinking.defaultBudgetTokens === undefined) {
      throw new BuiltinLlmConfigError(
        `${path}.anthropicThinking.defaultBudgetTokens`,
      );
    }
    for (let effortIndex = 0; effortIndex < efforts.length; effortIndex++) {
      const effort = efforts[effortIndex]!;
      if (effort !== 'none' && anthropicThinking.budgets?.[effort] === undefined) {
        throw new BuiltinLlmConfigError(`${path}.reasoning.efforts[${effortIndex}]`);
      }
    }
    const effectiveMaxTokens = Math.min(
      typeof model.outputTokenLimit === 'number'
        ? model.outputTokenLimit
        : DEFAULT_ANTHROPIC_MAX_TOKENS,
      typeof model.maximumOutputTokens === 'number'
        ? model.maximumOutputTokens
        : Number.POSITIVE_INFINITY,
    );
    const configuredBudgets = [
      anthropicThinking.defaultBudgetTokens,
      ...Object.values(anthropicThinking.budgets ?? {}),
    ].filter((value): value is number => value !== undefined);
    if (configuredBudgets.some((budget) => budget >= effectiveMaxTokens)) {
      throw new BuiltinLlmConfigError(`${path}.anthropicThinking`);
    }
  }

  return {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(anthropicThinking === undefined ? {} : { anthropicThinking }),
  };
}

function validateAnthropicThinkingAdapter(
  value: unknown,
  modelPath: string,
): AnthropicThinkingAdapter | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new BuiltinLlmConfigError(`${modelPath}.anthropicThinking`);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'mode' && key !== 'defaultBudgetTokens' && key !== 'budgets') {
      throw new BuiltinLlmConfigError(`${modelPath}.anthropicThinking.${key}`);
    }
  }
  if (value['mode'] === 'adaptive') {
    if (Object.hasOwn(value, 'defaultBudgetTokens') || Object.hasOwn(value, 'budgets')) {
      throw new BuiltinLlmConfigError(`${modelPath}.anthropicThinking`);
    }
    return Object.freeze({ mode: 'adaptive' as const });
  }
  if (value['mode'] !== 'budget') {
    throw new BuiltinLlmConfigError(`${modelPath}.anthropicThinking.mode`);
  }

  const defaultBudgetTokens = validateThinkingBudget(
    value['defaultBudgetTokens'],
    `${modelPath}.anthropicThinking.defaultBudgetTokens`,
  );
  const rawBudgets = value['budgets'];
  let budgets:
    | Partial<Record<Exclude<ExplicitThinkingEffort, 'none'>, number>>
    | undefined;
  if (rawBudgets !== undefined) {
    if (!isPlainObject(rawBudgets)) {
      throw new BuiltinLlmConfigError(`${modelPath}.anthropicThinking.budgets`);
    }
    budgets = {};
    const supportedEfforts = new Set([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    for (const [effort, rawBudget] of Object.entries(rawBudgets)) {
      if (!supportedEfforts.has(effort)) {
        throw new BuiltinLlmConfigError(
          `${modelPath}.anthropicThinking.budgets.${effort}`,
        );
      }
      budgets[effort as Exclude<ExplicitThinkingEffort, 'none'>] =
        validateThinkingBudget(
          rawBudget,
          `${modelPath}.anthropicThinking.budgets.${effort}`,
        )!;
    }
    Object.freeze(budgets);
  }
  return Object.freeze({
    mode: 'budget' as const,
    ...(defaultBudgetTokens === undefined ? {} : { defaultBudgetTokens }),
    ...(budgets === undefined ? {} : { budgets }),
  });
}

function validateThinkingBudget(
  value: unknown,
  fieldPath: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value)
    || (value as number) < MIN_ANTHROPIC_THINKING_BUDGET_TOKENS
  ) {
    throw new BuiltinLlmConfigError(fieldPath);
  }
  return value as number;
}

function validateReasoningCapabilities(
  value: unknown,
  modelPath: string,
): ReasoningCapabilities | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeReasoningCapabilities(value);
  } catch (error) {
    if (!(error instanceof ReasoningCapabilitiesValidationError)) throw error;
    const suffix = error.fieldPath.length === 0
      ? ''
      : error.fieldPath.startsWith('[')
        ? error.fieldPath
        : `.${error.fieldPath}`;
    throw new BuiltinLlmConfigError(`${modelPath}.reasoning${suffix}`);
  }
}

function copyConfiguredLimits(limits: Readonly<Record<string, unknown>>): {
  maximumContextTokens?: number;
  maximumPromptTokens?: number;
  maximumOutputTokens?: number;
  outputTokenLimit?: number;
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
    ...(typeof limits['outputTokenLimit'] === 'number'
      ? { outputTokenLimit: limits['outputTokenLimit'] }
      : {}),
  };
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
