// ── Config Wizard 输出策略核心 ─────────────────────────────
//
// 提供三个纯函数：
//   - pickSchemaKeys   按 DEFAULT_* 白名单过滤既有 config 字段，丢弃 schema 外字段
//   - diffAgainstDefaults  递归对比并 omit 等于 default 的字段
//   - buildNextConfig  组合三步 + 顶层段保留 + {} 清理，产出最终 ConfigFile
//
// Current contract: docs/architecture/current/platform_config.md#config-wizard

import { deepMerge } from '../loader.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from '../defaults.js';
import type {
  AgentDefaults,
  ConfigFile,
  DeepPartial,
  LoggerModuleConfig,
} from '../types.js';

// ── 工具 ──────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── pickSchemaKeys ────────────────────────────────────────

/**
 * 按 DEFAULT_* schema 白名单从 input 里挑字段。
 *
 * - 对象字段：递归过滤，schema 外 key 丢弃并记入 discarded
 * - 数组字段：整段透传，不递归过滤元素（wizard 不问数组内部）
 * - scalar 字段：原样透传
 * - 类型错配（schema 期望对象但 input 不是对象）：保守地返回 {}
 */
export function pickSchemaKeys<T>(
  input: unknown,
  schema: T,
  pathPrefix = '',
): { kept: DeepPartial<T>; discarded: string[] } {
  const discarded: string[] = [];
  const kept = pickSchemaKeysImpl(input, schema, pathPrefix, discarded);
  return { kept: kept as DeepPartial<T>, discarded };
}

function pickSchemaKeysImpl(
  input: unknown,
  schema: unknown,
  pathPrefix: string,
  discardedOut: string[],
): unknown {
  // schema 不是 plain object（scalar / array） → 直接透传 input
  if (!isPlainObject(schema)) {
    return input;
  }

  // schema 是 plain object 但 input 不是 → 形状错配，返回空对象
  if (!isPlainObject(input)) {
    return {};
  }

  const kept: Record<string, unknown> = {};

  // 标记 input 中 schema 没有的 key
  for (const key of Object.keys(input)) {
    if (!(key in schema)) {
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      addDiscardedLeafPaths(discardedOut, path, input[key]);
    }
  }

  // 递归处理 schema 内的 key
  for (const key of Object.keys(schema)) {
    if (!(key in input)) continue;
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    kept[key] = pickSchemaKeysImpl(input[key], schema[key], path, discardedOut);
  }

  return kept;
}

/**
 * 把 schema 外字段记入 discarded 列表。如果该字段本身是对象，
 * 递归把所有 leaf path 列出，方便 dry-run 提示具体丢了什么，
 * 而不仅是顶层 path（比如 'agents.defaults.experimental'）。
 */
function addDiscardedLeafPaths(out: string[], path: string, value: unknown): void {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push(path);
      return;
    }
    for (const key of keys) {
      addDiscardedLeafPaths(out, `${path}.${key}`, value[key]);
    }
  } else {
    out.push(path);
  }
}

// ── diffAgainstDefaults ───────────────────────────────────

/**
 * 递归提取 collected 中与 defaults 不同的字段。
 *
 * - undefined 不写入
 * - 与 default 完全相同的 scalar / 数组 → omit
 * - 嵌套对象递归处理；递归后子对象为空 {} 则父字段也 omit
 * - 数组用 JSON 字符串比对（顺序敏感，简单可靠）
 */
export function diffAgainstDefaults<T>(collected: T, defaults: T): DeepPartial<T> {
  const result = diffImpl(collected, defaults);
  return (result === undefined ? {} : result) as DeepPartial<T>;
}

function diffImpl(collected: unknown, defaults: unknown): unknown {
  // 都是数组：JSON 比对
  if (Array.isArray(collected) && Array.isArray(defaults)) {
    return JSON.stringify(collected) === JSON.stringify(defaults) ? undefined : collected;
  }

  // 都是 plain object：递归
  if (isPlainObject(collected) && isPlainObject(defaults)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(collected)) {
      const val = collected[key];
      if (val === undefined) continue;
      const sub = diffImpl(val, defaults[key]);
      if (sub === undefined) continue;
      if (isPlainObject(sub) && Object.keys(sub).length === 0) continue;
      result[key] = sub;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }

  // 其它情况：直接比较
  if (collected === defaults) return undefined;
  return collected;
}

// ── buildNextConfig ───────────────────────────────────────

export interface BuildNextConfigParams {
  /** 既有 config.json 内容（readFile + JSON.parse 后的对象；空对象表示无既有文件） */
  existing: ConfigFile;
  /** wizard 收集的字段（只含问过的字段） */
  collected: {
    agentsDefaults: DeepPartial<AgentDefaults>;
    logger: DeepPartial<LoggerModuleConfig>;
  };
}

export interface BuildNextConfigResult {
  /** 最终写入文件的 ConfigFile */
  next: ConfigFile;
  /** schema 外被丢弃的字段 path 列表（用于 dry-run 提示） */
  discarded: string[];
}

/**
 * §8 三步合并的入口函数：
 *
 *   existing.agents.defaults → pickSchemaKeys → deepMerge(collected) → diff vs DEFAULT
 *   existing.logger          → pickSchemaKeys → deepMerge(collected) → diff vs DEFAULT
 *
 * 然后与既有顶层段（agents.list / 未来段）合并 + {} 清理。
 */
export function buildNextConfig(params: BuildNextConfigParams): BuildNextConfigResult {
  const { existing, collected } = params;
  const discarded: string[] = [];

  // ── agents.defaults 三步 ──
  const existingAgentsDefaults = existing.agents?.defaults ?? {};
  const agentsPick = pickSchemaKeys(
    existingAgentsDefaults,
    DEFAULT_AGENT_CONFIG,
    'agents.defaults',
  );
  discarded.push(...agentsPick.discarded);

  // deepMerge 期待 target: T,这里 kept 是 DeepPartial,cast 为 AgentDefaults 安全
  // （deepMerge 实现只对 plain object 递归，不依赖完整性）
  const agentsMerged = deepMerge(
    agentsPick.kept as AgentDefaults,
    collected.agentsDefaults,
  );
  const agentsDiff = diffAgainstDefaults(agentsMerged as AgentDefaults, DEFAULT_AGENT_CONFIG);

  // ── logger 三步 ──
  const existingLogger = existing.logger ?? {};
  const loggerPick = pickSchemaKeys(existingLogger, DEFAULT_LOGGER_CONFIG, 'logger');
  discarded.push(...loggerPick.discarded);

  const loggerMerged = deepMerge(
    loggerPick.kept as LoggerModuleConfig,
    collected.logger,
  );
  const loggerDiff = diffAgainstDefaults(
    loggerMerged as LoggerModuleConfig,
    DEFAULT_LOGGER_CONFIG,
  );

  // ── 合并：顶层段（agents.list / 未来段）原样保留 ──
  const next: ConfigFile = {
    ...existing,
    agents: {
      ...existing.agents,
      defaults: agentsDiff,
    },
    logger: loggerDiff,
  };

  // ── {} 清理 ──
  if (next.agents?.defaults && Object.keys(next.agents.defaults).length === 0) {
    delete next.agents.defaults;
  }
  if (next.agents && Object.keys(next.agents).length === 0) {
    delete next.agents;
  }
  if (next.logger && Object.keys(next.logger).length === 0) {
    delete next.logger;
  }

  return { next, discarded };
}
