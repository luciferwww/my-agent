import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedHostExtensionsConfig } from '../../extension/acquisition/types.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from './defaults.js';
import { deepMerge, validateAgentModelSource } from './loader.js';
import {
  AgentConfigError,
  invalidAgentConfigField,
  unknownAgentConfigNamespace,
} from './agent-config-errors.js';
import type {
  AgentConfigDocument,
  AgentsConfig,
  ApplicationConfigProjection,
  LoggerLevel,
  LoggerModuleConfig,
} from './types.js';

const CONFIG_FILE_NAME = 'config.json';
const TOP_LEVEL_NAMESPACES = new Set(['agents', 'logger', 'extensions']);
const LOGGER_LEVELS = new Set<LoggerLevel>(['debug', 'info', 'warn', 'error']);

export interface AgentConfigSnapshot {
  readonly application: ApplicationConfigProjection;
  readonly extensions: ResolvedHostExtensionsConfig;
}

interface AgentConfigLoaderDependencies {
  readTextFile(path: string): Promise<string>;
}

const DEFAULT_DEPENDENCIES: AgentConfigLoaderDependencies = {
  readTextFile: (path) => readFile(path, 'utf8'),
};

/** Reads `<agentHome>/config.json` once and returns immutable consumer projections. */
export async function loadAgentConfig(options: {
  readonly agentHome: string;
}, dependencies: AgentConfigLoaderDependencies = DEFAULT_DEPENDENCIES): Promise<AgentConfigSnapshot> {
  const document = await readAgentConfigDocument(options.agentHome, dependencies);
  validateAgentConfigDocument(document);

  const defaults = document.agents?.defaults === undefined
    ? structuredClone(DEFAULT_AGENT_CONFIG)
    : deepMerge(
        structuredClone(DEFAULT_AGENT_CONFIG),
        structuredClone(document.agents.defaults),
      );
  const agents: AgentsConfig = {
    defaults,
    list: structuredClone(document.agents?.list ?? []),
  };
  const logger = document.logger === undefined
    ? structuredClone(DEFAULT_LOGGER_CONFIG)
    : deepMerge(
        structuredClone(DEFAULT_LOGGER_CONFIG),
        structuredClone(document.logger),
      );
  const extensions: ResolvedHostExtensionsConfig = {
    enabled: document.extensions?.enabled ?? true,
    entries: structuredClone(document.extensions?.entries ?? {}),
  };

  return deepFreeze({
    application: { agents, logger },
    extensions,
  });
}

async function readAgentConfigDocument(
  agentHome: string,
  dependencies: AgentConfigLoaderDependencies,
): Promise<AgentConfigDocument> {
  let raw: string;
  try {
    raw = await dependencies.readTextFile(join(agentHome, CONFIG_FILE_NAME));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new AgentConfigError(
        'FILE_MISSING',
        'Agent configuration file is missing.',
      );
    }
    throw new AgentConfigError(
      'FILE_UNREADABLE',
      'Agent configuration file could not be read.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentConfigError(
      'INVALID_JSON',
      'Agent configuration file contains invalid JSON.',
    );
  }
  if (!isPlainObject(parsed)) {
    throw new AgentConfigError(
      'ROOT_INVALID',
      'Agent configuration root must be an object.',
    );
  }
  return parsed as AgentConfigDocument;
}

function validateAgentConfigDocument(document: AgentConfigDocument): void {
  for (const namespace of Object.keys(document)) {
    if (!TOP_LEVEL_NAMESPACES.has(namespace)) {
      throw unknownAgentConfigNamespace(namespace);
    }
  }

  validateAgents(document.agents);
  validateLogger(document.logger);
  validateExtensions(document.extensions);
}

function validateAgents(value: AgentConfigDocument['agents']): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField('agents');
  if (value.defaults !== undefined && !isPlainObject(value.defaults)) {
    throw invalidAgentConfigField('agents.defaults');
  }
  if (value.defaults !== undefined) {
    if ('workspace' in value.defaults) {
      throw invalidAgentConfigField('agents.defaults.workspace');
    }
    rejectRetiredToolsConfig(value.defaults, 'agents.defaults');
    validateAgentModelSourceAt(value.defaults, 'agents.defaults');
  }
  if (value.list === undefined) return;
  if (!Array.isArray(value.list)) throw invalidAgentConfigField('agents.list');
  for (const [index, entry] of value.list.entries()) {
    const entryPath = `agents.list[${index}]`;
    if (!isPlainObject(entry)) throw invalidAgentConfigField(entryPath);
    if (typeof entry['id'] !== 'string' || entry['id'].trim().length === 0) {
      throw invalidAgentConfigField(`${entryPath}.id`);
    }
    if (entry['default'] !== undefined && typeof entry['default'] !== 'boolean') {
      throw invalidAgentConfigField(`${entryPath}.default`);
    }
    if ('workspace' in entry) {
      throw invalidAgentConfigField(`${entryPath}.workspace`);
    }
    rejectRetiredToolsConfig(entry, entryPath);
    validateAgentModelSourceAt(entry, entryPath);
  }
}

function validateLogger(value: AgentConfigDocument['logger']): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField('logger');
  validateLoggerLevel(value['minLevel'], 'logger.minLevel');
  validateLoggerAdapter(value['console'], 'logger.console');
  validateLoggerAdapter(value['file'], 'logger.file');
}

function validateLoggerAdapter(value: unknown, fieldPath: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField(fieldPath);
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    throw invalidAgentConfigField(`${fieldPath}.enabled`);
  }
  validateLoggerLevel(value['minLevel'], `${fieldPath}.minLevel`);
}

function validateLoggerLevel(value: unknown, fieldPath: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !LOGGER_LEVELS.has(value as LoggerLevel)) {
    throw invalidAgentConfigField(fieldPath);
  }
}

function validateExtensions(value: AgentConfigDocument['extensions']): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField('extensions');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw invalidAgentConfigField('extensions.enabled');
  }
  if (value.entries !== undefined && !isPlainObject(value.entries)) {
    throw invalidAgentConfigField('extensions.entries');
  }
}

function validateAgentModelSourceAt(value: unknown, fieldPath: string): void {
  try {
    validateAgentModelSource(value, fieldPath);
  } catch {
    throw invalidAgentConfigField(fieldPath);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}

function rejectRetiredToolsConfig(
  value: Readonly<Record<string, unknown>>,
  fieldPath: string,
): void {
  const tools = value['tools'];
  if (isPlainObject(tools) && 'fs' in tools) {
    throw invalidAgentConfigField(`${fieldPath}.tools.fs`);
  }
}