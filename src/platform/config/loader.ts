import type { AppConfig, AgentDefaults, DeepPartial } from './types.js';
import type { ModelReference } from '../../core/model-resolution/index.js';

// ── 深度合并 ──────────────────────────────────────────────

/**
 * 深度合并两个对象。source 中的非 undefined 值覆盖 target。
 *
 * 规则：
 * - 两边都是普通对象 → 递归合并
 * - source 值为 undefined → 保留 target 值
 * - 其他情况 → source 覆盖 target
 */
type MergeableObject<T> = {
  [K in keyof T]: unknown;
};

export function deepMerge<T extends MergeableObject<T>>(
  target: T,
  source: DeepPartial<T>,
): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    if (sourceVal === undefined) continue;

    const targetVal = result[key];

    if (
      isPlainObject(targetVal) &&
      isPlainObject(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as DeepPartial<Record<string, unknown>>,
      ) as T[keyof T];
    } else {
      result[key] = sourceVal as T[keyof T];
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── 环境变量映射 ──────────────────────────────────────────

/** 从环境变量中提取配置覆盖 */
export function getEnvOverrides(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeepPartial<AgentDefaults> {
  const overrides: DeepPartial<AgentDefaults> = {};

  const apiKey = environment['ANTHROPIC_API_KEY'];
  const baseURL = environment['ANTHROPIC_BASE_URL'];
  const providerId = environment['MY_AGENT_PROVIDER'];
  const modelId = environment['MY_AGENT_MODEL'];

  if ((providerId === undefined) !== (modelId === undefined)) {
    throw new Error('MY_AGENT_PROVIDER and MY_AGENT_MODEL must be provided together.');
  }
  if (providerId !== undefined && modelId !== undefined) {
    overrides.model = validateModelReference({ providerId, modelId }, 'environment');
  }

  if (apiKey || baseURL) {
    overrides.llm = {};
    if (apiKey) overrides.llm.apiKey = apiKey;
    if (baseURL) overrides.llm.baseURL = baseURL;
  }

  return overrides;
}

// ── resolveAgentConfig ───────────────────────────────────

export interface ResolveOptions {
  /** agent 标识，从 agents.list 中查找 */
  agentId?: string;
  /** 环境变量覆盖 */
  envOverrides?: DeepPartial<AgentDefaults>;
  /** CLI 参数覆盖 */
  cliOverrides?: DeepPartial<AgentDefaults>;
}

/**
 * 产出指定 agent 的最终配置。
 *
 * 在 loadConfig 已完成第 1、2 步（硬编码 + 文件 defaults 合并）的基础上，
 * 继续合并：
 *   1. agents.list 中匹配 agentId 的条目（per-agent 覆盖）
 *   2. envOverrides（环境变量）
 *   3. cliOverrides（CLI 参数）
 *
 * 不传 agentId 或未找到时跳过第 1 步。
 */
export function resolveAgentConfig(
  config: AppConfig,
  options?: ResolveOptions,
): AgentDefaults {
  if (options?.envOverrides) validateAgentModelSource(options.envOverrides, 'environment overrides');
  if (options?.cliOverrides) validateAgentModelSource(options.cliOverrides, 'CLI overrides');
  let resolved = { ...config.agents.defaults };

  // 1. per-agent 覆盖
  if (options?.agentId) {
    const entry = config.agents.list.find((e) => e.id === options.agentId);
    if (entry) {
      // 从 AgentEntry 中提取覆盖字段（排除 id 和 default）
      const { id: _id, default: _default, ...overrides } = entry;
      resolved = deepMerge(resolved, overrides as DeepPartial<AgentDefaults>);
    }
  }

  // 2. 环境变量覆盖
  if (options?.envOverrides) {
    resolved = deepMerge(resolved, options.envOverrides);
  }

  // 3. CLI 覆盖
  if (options?.cliOverrides) {
    resolved = deepMerge(resolved, options.cliOverrides);
  }

  validateAgentModelSource(resolved, 'resolved agent config');
  return resolved;
}

export function validateAgentModelSource(source: unknown, label: string): void {
  if (!isPlainObject(source)) return;
  const llm = source['llm'];
  if (isPlainObject(llm) && Object.prototype.hasOwnProperty.call(llm, 'model')) {
    throw new Error(`${label} uses legacy llm.model; use model.providerId and model.modelId.`);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'model') && source['model'] !== undefined) {
    validateModelReference(source['model'], label);
  }
}

function validateModelReference(value: unknown, label: string): ModelReference {
  if (!isPlainObject(value)) {
    throw new Error(`${label} model must be a structured Provider and Model reference.`);
  }
  const providerId = typeof value['providerId'] === 'string' ? value['providerId'].trim() : '';
  const modelId = value['modelId'];
  if (!providerId || typeof modelId !== 'string') {
    throw new Error(`${label} model requires a non-empty providerId and string modelId.`);
  }
  return Object.freeze({ providerId, modelId });
}
