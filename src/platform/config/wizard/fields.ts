// ── Config Wizard 字段定义 ────────────────────────────────
//
// Current contract: docs/architecture/current/platform_config.md#config-wizard
// 将当前可配置 schema 翻译成 Prompt<T> 工厂 + 分段组织。
//
// 每个段是一个函数 askXxx(session, current): Promise<{ kept }>，
// 负责按设计文档的顺序问完该段所有字段，应用条件跳过规则，
// 返回收集到的字段（只含 wizard 问过的）。

import type { ReadlineSession } from './prompts.js';
import { ask, askYesNo, parseBoolean, parseEnum, parseInteger, parseNumber, parseString } from './prompts.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from '../defaults.js';
import type {
  AgentDefaults,
  DeepPartial,
  EmbeddingProviderType,
  LoggerLevel,
  LoggerModuleConfig,
  SafetyLevel,
} from '../types.js';

// ── 工具：把 ask() 结果展开到嵌套对象 ─────────────────────

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (!(k in cur) || typeof cur[k] !== 'object' || cur[k] === null) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** 获取嵌套路径上的值（path 不存在时返回 undefined） */
function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const k of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// ── ask helper ────────────────────────────────────────────

/**
 * 问一个字段，把结果按 path 写入 collected。返回 collected（链式调用方便）。
 *
 * `current` 从 existingFull 中按 path 取出（既有文件提供）；
 * `default` 从 DEFAULT_* 中按 path 取出（用于 ask() 内部展示，但 wizard 不区分）。
 */
async function askField<T>(opts: {
  session: ReadlineSession;
  collected: Record<string, unknown>;
  existing: unknown;
  defaults: unknown;
  path: string;
  label: string;
  parse: (s: string) => T;
  display?: (v: T | undefined) => string;
  validate?: (v: T) => void;
}): Promise<void> {
  const current = getPath(opts.existing, opts.path) as T | undefined;
  const dflt = getPath(opts.defaults, opts.path) as T;

  const value = await ask<T>(opts.session, {
    path: opts.path,
    label: opts.label,
    current: current ?? dflt,
    default: dflt,
    parse: opts.parse,
    display: opts.display,
    validate: opts.validate,
  });

  setPath(opts.collected, opts.path, value);
}

// ── CoreFields ────────────────────────────────────────────

export interface CoreCollected {
  agentsDefaults: DeepPartial<AgentDefaults>;
  logger: DeepPartial<LoggerModuleConfig>;
  /** 副带回的几个开关，用于高级段决定是否跳过相关子段 */
  flags: {
    memoryEnabled: boolean;
    loggerFileEnabled: boolean;
  };
}

/**
 * 必问字段（§6 核心清单）。
 *
 * 顺序：apiKey / baseURL / model / maxTokens / contextWindowTokens
 *   → memory.enabled
 *   → logger.minLevel / logger.file.enabled
 */
export async function askCoreFields(
  session: ReadlineSession,
  existing: { agentsDefaults: unknown; logger: unknown },
): Promise<CoreCollected> {
  const agentsDefaults: Record<string, unknown> = {};
  const logger: Record<string, unknown> = {};

  process.stdout.write('\n━━ Core fields ━━\n\n');

  // llm
  await askField({
    session,
    collected: agentsDefaults,
    existing: existing.agentsDefaults,
    defaults: DEFAULT_AGENT_CONFIG,
    path: 'llm.apiKey',
    label: 'Anthropic API key',
    parse: parseString,
  });
  await askField({
    session,
    collected: agentsDefaults,
    existing: existing.agentsDefaults,
    defaults: DEFAULT_AGENT_CONFIG,
    path: 'llm.baseURL',
    label: 'LLM base URL (e.g. LiteLLM proxy)',
    parse: parseString,
  });
  await askField({
    session,
    collected: agentsDefaults,
    existing: existing.agentsDefaults,
    defaults: DEFAULT_AGENT_CONFIG,
    path: 'llm.model',
    label: 'Default model id',
    parse: parseString,
  });
  await askField({
    session,
    collected: agentsDefaults,
    existing: existing.agentsDefaults,
    defaults: DEFAULT_AGENT_CONFIG,
    path: 'llm.maxTokens',
    label: 'LLM max tokens per response',
    parse: parseInteger,
    validate: (n) => { if (n <= 0) throw new Error('must be > 0'); },
  });
  await askField({
    session,
    collected: agentsDefaults,
    existing: existing.agentsDefaults,
    defaults: DEFAULT_AGENT_CONFIG,
    path: 'llm.contextWindowTokens',
    label: 'Model context window (tokens)',
    parse: parseInteger,
    validate: (n) => { if (n <= 0) throw new Error('must be > 0'); },
  });

  // memory
  await askField({
    session,
    collected: agentsDefaults,
    existing: existing.agentsDefaults,
    defaults: DEFAULT_AGENT_CONFIG,
    path: 'memory.enabled',
    label: 'Enable memory module',
    parse: parseBoolean,
  });
  const memoryEnabled = (getPath(agentsDefaults, 'memory.enabled') as boolean | undefined) ?? true;

  // logger
  await askField({
    session,
    collected: logger,
    existing: existing.logger,
    defaults: DEFAULT_LOGGER_CONFIG,
    path: 'minLevel',
    label: 'Logger min level (debug/info/warn/error)',
    parse: parseEnum<LoggerLevel>(['debug', 'info', 'warn', 'error']),
  });
  await askField({
    session,
    collected: logger,
    existing: existing.logger,
    defaults: DEFAULT_LOGGER_CONFIG,
    path: 'file.enabled',
    label: 'Enable logger file adapter',
    parse: parseBoolean,
  });
  const loggerFileEnabled =
    (getPath(logger, 'file.enabled') as boolean | undefined) ??
    DEFAULT_LOGGER_CONFIG.file?.enabled ??
    false;

  return {
    agentsDefaults: agentsDefaults as DeepPartial<AgentDefaults>,
    logger: logger as DeepPartial<LoggerModuleConfig>,
    flags: { memoryEnabled, loggerFileEnabled },
  };
}

// ── AdvancedFields ────────────────────────────────────────

/**
 * 高级字段（§7 可选展开）。
 *
 * 进入前先问 `configure advanced? y/N`；答 y 才逐段问。
 * 每段开头打印分隔线，关联开关（memory.enabled / compaction.enabled / file.enabled）决定是否跳过子段。
 */
export async function askAdvancedFields(
  session: ReadlineSession,
  existing: { agentsDefaults: unknown; logger: unknown },
  core: CoreCollected,
): Promise<{
  agentsDefaults: DeepPartial<AgentDefaults>;
  logger: DeepPartial<LoggerModuleConfig>;
}> {
  const wantAdvanced = await askYesNo(session, '\nConfigure advanced fields?', false);
  if (!wantAdvanced) {
    return { agentsDefaults: core.agentsDefaults, logger: core.logger };
  }

  const a = { ...(core.agentsDefaults as Record<string, unknown>) };
  const l = { ...(core.logger as Record<string, unknown>) };

  // ── runner ──
  process.stdout.write('\n── runner ──\n');
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'runner.maxLlmCalls', label: 'Runner max LLM calls per turn',
    parse: parseInteger, validate: (n) => { if (n <= 0) throw new Error('must be > 0'); },
  });
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'runner.inTurnMessageMode', label: 'In-turn message mode (steer/followup)',
    parse: parseEnum(['steer', 'followup'] as const),
  });

  // ── memory.* (only if enabled) ──
  if (core.flags.memoryEnabled) {
    process.stdout.write('\n── memory.embedding ──\n');
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.embedding.provider', label: 'Embedding provider',
      parse: parseEnum<EmbeddingProviderType>(['local', 'openai']),
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.embedding.model', label: 'Embedding model id',
      parse: parseString,
    });
    process.stdout.write('\n── memory.chunking ──\n');
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.chunking.chunkChars', label: 'Chunk size (chars)', parse: parseInteger,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.chunking.overlapChars', label: 'Chunk overlap (chars)', parse: parseInteger,
    });

    process.stdout.write('\n── memory.search ──\n');
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.search.maxResults', label: 'Search max results', parse: parseInteger,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.search.minScore', label: 'Search min score (0..1)', parse: parseNumber,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.search.vectorWeight', label: 'Vector weight (0..1)', parse: parseNumber,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'memory.search.textWeight', label: 'Text weight (0..1)', parse: parseNumber,
    });
  }

  // ── prompt ──
  process.stdout.write('\n── prompt ──\n');
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'prompt.safetyLevel', label: 'Safety level',
    parse: parseEnum<SafetyLevel>(['strict', 'normal', 'relaxed']),
  });

  // ── tools ──
  process.stdout.write('\n── tools ──\n');
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'tools.fs.workspaceOnly', label: 'Restrict fs tools to workspace dir', parse: parseBoolean,
  });

  // ── workspace ──
  process.stdout.write('\n── workspace ──\n');
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'workspace.maxFileChars', label: 'Context file max chars (per file)', parse: parseInteger,
  });
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'workspace.maxTotalChars', label: 'Context total max chars', parse: parseInteger,
  });

  // ── compaction ──
  process.stdout.write('\n── compaction ──\n');
  await askField({
    session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
    path: 'compaction.enabled', label: 'Enable compaction', parse: parseBoolean,
  });
  const compactionEnabled =
    (getPath(a, 'compaction.enabled') as boolean | undefined) ??
    DEFAULT_AGENT_CONFIG.compaction.enabled;
  if (compactionEnabled) {
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'compaction.reserveTokens', label: 'Compaction reserve tokens', parse: parseInteger,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'compaction.keepRecentTurns', label: 'Keep recent turns', parse: parseInteger,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'compaction.toolResultContextShare', label: 'Tool result context share (0..1)', parse: parseNumber,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'compaction.toolResultHeadChars', label: 'Tool result head chars', parse: parseInteger,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'compaction.toolResultTailChars', label: 'Tool result tail chars', parse: parseInteger,
    });
    await askField({
      session, collected: a, existing: existing.agentsDefaults, defaults: DEFAULT_AGENT_CONFIG,
      path: 'compaction.timeoutSeconds', label: 'Compaction timeout (seconds)', parse: parseInteger,
    });
  }

  // ── logger.console ──
  process.stdout.write('\n── logger.console ──\n');
  await askField({
    session, collected: l, existing: existing.logger, defaults: DEFAULT_LOGGER_CONFIG,
    path: 'console.enabled', label: 'Enable logger console adapter', parse: parseBoolean,
  });
  await askField({
    session, collected: l, existing: existing.logger, defaults: DEFAULT_LOGGER_CONFIG,
    path: 'console.minLevel', label: 'Console adapter min level',
    parse: parseEnum<LoggerLevel>(['debug', 'info', 'warn', 'error']),
  });

  // ── logger.file (only if enabled) ──
  if (core.flags.loggerFileEnabled) {
    process.stdout.write('\n── logger.file ──\n');
    await askField({
      session, collected: l, existing: existing.logger, defaults: DEFAULT_LOGGER_CONFIG,
      path: 'file.minLevel', label: 'File adapter min level',
      parse: parseEnum<LoggerLevel>(['debug', 'info', 'warn', 'error']),
    });
  }

  return {
    agentsDefaults: a as DeepPartial<AgentDefaults>,
    logger: l as DeepPartial<LoggerModuleConfig>,
  };
}
