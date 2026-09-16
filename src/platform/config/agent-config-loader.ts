import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedHostExtensionsConfig } from '../../extension-acquisition/types.js';
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
  StandaloneHostMode,
} from './types.js';

const CONFIG_FILE_NAME = 'config.json';
const TOP_LEVEL_NAMESPACES = new Set(['agents', 'logger', 'extensions', 'host']);
const LOGGER_LEVELS = new Set<LoggerLevel>(['debug', 'info', 'warn', 'error']);

export interface StandaloneHostConfigProjection {
  readonly mode: StandaloneHostMode;
  readonly websocket: Readonly<{
    host: string;
    port: number;
    path: string;
    approval: boolean;
  }>;
  readonly cli: Readonly<{
    sessionKey: string;
    prompt: string;
    approval: boolean;
  }>;
}

export interface AgentConfigSnapshot {
  readonly application: ApplicationConfigProjection;
  readonly extensions: ResolvedHostExtensionsConfig;
  readonly host: StandaloneHostConfigProjection;
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
  const host = resolveHostConfig(document.host);

  return deepFreeze({
    application: { agents, logger },
    extensions,
    host,
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
    if (hasErrorCode(error, 'ENOENT')) return {};
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
  validateHost(document.host);
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

function validateHost(value: AgentConfigDocument['host']): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField('host');
  rejectUnknownFields(value, ['mode', 'websocket', 'cli'], 'host');
  if (
    value.mode !== undefined
    && value.mode !== 'websocket'
    && value.mode !== 'cli'
    && value.mode !== 'headless'
  ) {
    throw invalidAgentConfigField('host.mode');
  }

  if (value.websocket !== undefined) {
    if (!isPlainObject(value.websocket)) throw invalidAgentConfigField('host.websocket');
    rejectUnknownFields(value.websocket, ['host', 'port', 'path', 'approval'], 'host.websocket');
    if (value.websocket.host !== undefined) {
      validateNonBlankString(value.websocket.host, 'host.websocket.host');
    }
    if (
      value.websocket.port !== undefined
      && (!Number.isInteger(value.websocket.port)
        || value.websocket.port < 1
        || value.websocket.port > 65_535)
    ) {
      throw invalidAgentConfigField('host.websocket.port');
    }
    if (
      value.websocket.path !== undefined
      && (typeof value.websocket.path !== 'string' || !value.websocket.path.startsWith('/'))
    ) {
      throw invalidAgentConfigField('host.websocket.path');
    }
    validateOptionalBoolean(value.websocket.approval, 'host.websocket.approval');
  }

  if (value.cli !== undefined) {
    if (!isPlainObject(value.cli)) throw invalidAgentConfigField('host.cli');
    rejectUnknownFields(value.cli, ['sessionKey', 'prompt', 'approval'], 'host.cli');
    if (value.cli.sessionKey !== undefined) {
      validateNonBlankString(value.cli.sessionKey, 'host.cli.sessionKey');
    }
    if (value.cli.prompt !== undefined && typeof value.cli.prompt !== 'string') {
      throw invalidAgentConfigField('host.cli.prompt');
    }
    validateOptionalBoolean(value.cli.approval, 'host.cli.approval');
  }
}

function resolveHostConfig(
  value: AgentConfigDocument['host'],
): StandaloneHostConfigProjection {
  return {
    mode: value?.mode ?? 'websocket',
    websocket: {
      host: value?.websocket?.host ?? '127.0.0.1',
      port: value?.websocket?.port ?? 8787,
      path: value?.websocket?.path ?? '/ws',
      approval: value?.websocket?.approval ?? true,
    },
    cli: {
      sessionKey: value?.cli?.sessionKey ?? 'main',
      prompt: value?.cli?.prompt ?? '> ',
      approval: value?.cli?.approval ?? true,
    },
  };
}

function rejectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
  fieldPath: string,
): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw invalidAgentConfigField(`${fieldPath}.${unknown}`);
}

function validateNonBlankString(value: unknown, fieldPath: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidAgentConfigField(fieldPath);
  }
}

function validateOptionalBoolean(value: unknown, fieldPath: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw invalidAgentConfigField(fieldPath);
  }
}