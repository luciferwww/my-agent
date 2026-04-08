import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_AGENT_CONFIG } from './defaults.js';
import type { AppConfig, AgentDefaults, AgentEntry, ConfigFile, DeepPartial } from './types.js';

const CONFIG_FILE_NAME = 'config.json';

// ── 深度合并 ──────────────────────────────────────────────

/**
 * 深度合并两个对象。source 中的非 undefined 值覆盖 target。
 *
 * 规则：
 * - 两边都是普通对象 → 递归合并
 * - source 值为 undefined → 保留 target 值
 * - 其他情况 → source 覆盖 target
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: DeepPartial<T>,
): T {
  const result = { ...target };

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
export function getEnvOverrides(): DeepPartial<AgentDefaults> {
  const overrides: DeepPartial<AgentDefaults> = {};

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const baseURL = process.env['ANTHROPIC_BASE_URL'];
  const model = process.env['MY_AGENT_MODEL'];

  if (apiKey || baseURL || model) {
    overrides.llm = {};
    if (apiKey) overrides.llm.apiKey = apiKey;
    if (baseURL) overrides.llm.baseURL = baseURL;
    if (model) overrides.llm.model = model;
  }

  return overrides;
}

// ── 配置文件加载 ──────────────────────────────────────────

/** 从 .agent/config.json 读取配置。文件不存在或格式错误返回空对象。 */
function readConfigFile(workspaceDir: string): ConfigFile {
  const agentDir = DEFAULT_AGENT_CONFIG.workspace.agentDir;
  const configPath = join(workspaceDir, agentDir, CONFIG_FILE_NAME);

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // 基本类型校验：顶层必须是对象
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    return parsed as ConfigFile;
  } catch {
    // 文件不存在、权限不足、JSON 语法错误 → 降级为空配置
    return {};
  }
}

// ── loadConfig ───────────────────────────────────────────

export interface LoadConfigOptions {
  /** 工作区根目录 */
  workspaceDir: string;
}

/**
 * 加载配置。
 *
 * 合并硬编码默认值和 config.json 文件，返回 AppConfig。
 * 环境变量和 CLI 覆盖不在此处合并——由 resolveAgentConfig() 负责。
 */
export function loadConfig(options: LoadConfigOptions): AppConfig {
  const { workspaceDir } = options;

  // 1. 起点：硬编码默认值
  let defaults: AgentDefaults = { ...DEFAULT_AGENT_CONFIG };

  // 2. 合并配置文件中的 agents.defaults
  const file = readConfigFile(workspaceDir);
  if (file.agents?.defaults) {
    defaults = deepMerge(defaults, file.agents.defaults);
  }

  return {
    workspaceDir,
    agents: {
      defaults,
      list: file.agents?.list ?? [],
    },
  };
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

  return resolved;
}
