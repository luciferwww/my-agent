import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedHostExtensionsConfig } from '../../extension/acquisition/types.js';
import {
  BuiltinLlmConfigError,
  validateBuiltinLlmProviderConfig,
  type LLMConfig,
} from '../../builtins/providers/builtin/index.js';
import { DEFAULT_RUNNER_CONFIG } from '../../core/runner/config.js';
import { DEFAULT_MEMORY_CONFIG } from '../../core/memory/index.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  SubagentDepthValidationError,
  validateMaxSubagentDepth,
} from '../../core/subagent/index.js';
import { DEFAULT_LOGGER_CONFIG, LoggerConfigValidationError, validateLoggerConfig } from '../logger/index.js';
import { createDefaultAgentConfig } from './default-composition.js';
import { deepMerge } from './loader.js';
import {
  AgentConfigError,
  invalidAgentConfigField,
  removedGlobalExtensionsSwitch,
  unavailableConfigSecret,
  unknownAgentConfigNamespace,
} from './agent-config-errors.js';
import {
  CredentialMaterializationError,
  materializeExactStringCredential,
  parseCredentialEnvironmentReference,
} from './credential-materialization.js';
import { projectAgentCapabilities, validateAgentLeafConfig, validateRunnerConfigSection, validateMemoryConfigSection } from './agent-leaf-validation.js';
import { isNamedAgentId } from '../../core/agent-context/index.js';
import type {
  AgentConfigDocument,
  AgentExecutionConfig,
  AgentsConfig,
  ApplicationConfigProjection,
  MemoryConfig,
  DeepPartial,
} from './types.js';

const CONFIG_FILE_NAME = 'config.json';
const TOP_LEVEL_NAMESPACES = new Set([
  'llm',
  'agents',
  'logger',
  'extensions',
]);

export interface AgentConfigSnapshot {
  /** Server-only editing source; contains raw credentials, not a Channel projection. */
  readonly document?: AgentConfigDocument;
  readonly application: ApplicationConfigProjection;
  readonly extensions: ResolvedHostExtensionsConfig;
}

interface AgentConfigLoaderDependencies {
  readTextFile(path: string): Promise<string>;
}

const DEFAULT_DEPENDENCIES: AgentConfigLoaderDependencies = {
  readTextFile: (path) => readFile(path, 'utf8'),
};

export function getAgentExecutionSettings(document: AgentConfigDocument): Partial<AgentExecutionConfig> {
  const agents = document.agents;
  return {
    ...(agents?.steeringEnabled === undefined ? {} : { steeringEnabled: agents.steeringEnabled }),
    ...(agents?.maxSubagentDepth === undefined ? {} : { maxSubagentDepth: agents.maxSubagentDepth }),
    ...(agents?.maxLlmCallsPerTurn === undefined ? {} : { maxLlmCallsPerTurn: agents.maxLlmCallsPerTurn }),
  };
}

export function resolveAgentExecutionConfig(
  settings: Partial<AgentExecutionConfig> = {},
): AgentExecutionConfig {
  return {
    steeringEnabled: settings.steeringEnabled ?? DEFAULT_RUNNER_CONFIG.steeringEnabled,
    maxSubagentDepth: settings.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    ...(settings.maxLlmCallsPerTurn === undefined ? {} : { maxLlmCallsPerTurn: settings.maxLlmCallsPerTurn }),
  };
}

export function resolveMemoryConfig(settings: DeepPartial<MemoryConfig> = {}): MemoryConfig {
  validateMemoryConfigSection(settings);
  const resolved = deepMerge(structuredClone(DEFAULT_MEMORY_CONFIG), settings);
  validateMemoryConfigSection(resolved);
  return resolved;
}

/** Reads `<agentHome>/config.json` once and returns immutable consumer projections. */
export async function loadAgentConfig(options: {
  readonly agentHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}, dependencies: AgentConfigLoaderDependencies = DEFAULT_DEPENDENCIES): Promise<AgentConfigSnapshot> {
  const document = await readAgentConfigDocument(options.agentHome, dependencies);
  const llm = validateLlm(document.llm, options.environment ?? process.env);
  validateAgentConfigDocument(document);
  const defaultAgentConfig = createDefaultAgentConfig();
  const projectedDefaults = document.agents?.defaults === undefined
    ? undefined : projectAgentCapabilities(document.agents.defaults, 'agents.defaults');
  const list = (document.agents?.list ?? []).map((entry, index) => ({
    id: entry.id,
    ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.model === undefined ? {} : { model: entry.model === 'inherit'
      ? 'inherit' as const : { providerId: entry.model.providerId.trim(), modelId: entry.model.modelId } }),
    ...projectAgentCapabilities(entry, `agents.list[${index}]`),
  }));
  const defaults = document.agents?.defaults === undefined
    ? defaultAgentConfig
    : deepMerge(
        defaultAgentConfig,
        projectedDefaults ?? {},
      );
  validateAgentLeafConfig(defaults, 'agents.defaults');
  for (const [index, entry] of list.entries()) {
    validateAgentLeafConfig(
      deepMerge(structuredClone(defaults), projectAgentCapabilities(entry, `agents.list[${index}]`)),
      `agents.list[${index}]`,
    );
  }
  const agents: AgentsConfig = {
    ...resolveAgentExecutionConfig(document.agents),
    memory: resolveMemoryConfig(document.agents?.memory),
    defaults,
    list,
  };
  const logger = document.logger === undefined
    ? structuredClone(DEFAULT_LOGGER_CONFIG)
    : deepMerge(
        structuredClone(DEFAULT_LOGGER_CONFIG),
        structuredClone(document.logger),
      );
  const extensions: ResolvedHostExtensionsConfig = {
    entries: structuredClone(document.extensions?.entries ?? {}),
  };

  return deepFreeze({
    document: structuredClone(document),
    application: { llm, agents, logger },
    extensions,
  });
}

export async function readAgentConfigDocument(
  agentHome: string,
  dependencies: AgentConfigLoaderDependencies = DEFAULT_DEPENDENCIES,
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

export function validateAgentConfigDocument(document: AgentConfigDocument): void {
  for (const namespace of Object.keys(document)) {
    if (!TOP_LEVEL_NAMESPACES.has(namespace)) {
      throw unknownAgentConfigNamespace(namespace);
    }
  }

  validateAgents(document.agents);
  validateLogger(document.logger);
  validateExtensions(document.extensions);
}

export function validateLlm(
  value: AgentConfigDocument['llm'],
  environment?: Readonly<Record<string, string | undefined>>,
): LLMConfig {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw invalidAgentConfigField('llm');

  const defaultModel = value['defaultModel'] === undefined
    ? undefined
    : validateModelReference(value['defaultModel'], 'llm.defaultModel');
  let builtin;
  try {
    builtin = value['builtin'] === undefined
      ? undefined
      : validateBuiltinLlmProviderConfig(value['builtin']);
  } catch (error) {
    if (!(error instanceof BuiltinLlmConfigError)) throw error;
    const fieldPath = error.fieldPath.length === 0
      ? 'llm.builtin'
      : `llm.builtin.${error.fieldPath}`;
    throw invalidAgentConfigField(fieldPath);
  }
  if (builtin?.apiKey !== undefined) {
    try {
      parseCredentialEnvironmentReference(builtin.apiKey);
      const apiKey = environment === undefined
        ? builtin.apiKey
        : materializeExactStringCredential(builtin.apiKey, environment);
      builtin = {
        ...builtin,
        ...(apiKey === undefined ? {} : { apiKey }),
      };
      if (apiKey === undefined) delete (builtin as { apiKey?: string }).apiKey;
    } catch (error) {
      if (!(error instanceof CredentialMaterializationError)) throw error;
      if (error.secretUnavailable && error.environmentVariable !== undefined) {
        throw unavailableConfigSecret('llm.builtin.apiKey', error.environmentVariable);
      }
      throw invalidAgentConfigField('llm.builtin.apiKey');
    }
  }

  return {
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(builtin === undefined ? {} : { builtin }),
  };
}

function validateAgents(value: AgentConfigDocument['agents']): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField('agents');
  resolveMemoryConfig(value.memory);
  validateRunnerConfigSection({
    ...(value.steeringEnabled === undefined
      ? {}
      : { steeringEnabled: value.steeringEnabled }),
    ...(value.maxLlmCallsPerTurn === undefined
      ? {}
      : { maxLlmCallsPerTurn: value.maxLlmCallsPerTurn }),
  }, 'agents');
  if (value.maxSubagentDepth !== undefined) {
    try {
      validateMaxSubagentDepth(value.maxSubagentDepth);
    } catch (error) {
      if (!(error instanceof SubagentDepthValidationError)) throw error;
      throw invalidAgentConfigField('agents.maxSubagentDepth');
    }
  }
  if (value.defaults !== undefined && !isPlainObject(value.defaults)) {
    throw invalidAgentConfigField('agents.defaults');
  }
  if (value.defaults !== undefined) {
    projectAgentCapabilities(value.defaults, 'agents.defaults');
  }
  if (value.list === undefined) return;
  if (!Array.isArray(value.list)) throw invalidAgentConfigField('agents.list');
  const seen = new Set<string>();
  for (const [index, entry] of value.list.entries()) {
    const entryPath = `agents.list[${index}]`;
    if (!isPlainObject(entry)) throw invalidAgentConfigField(entryPath);
    if (!isNamedAgentId(entry['id']) || seen.has(entry['id'])) {
      throw invalidAgentConfigField(`${entryPath}.id`);
    }
    seen.add(entry['id']);
    if (entry['description'] !== undefined && (
      typeof entry['description'] !== 'string'
      || entry['description'].trim().length === 0
    )) {
      throw invalidAgentConfigField(`${entryPath}.description`);
    }
    if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') {
      throw invalidAgentConfigField(`${entryPath}.enabled`);
    }
    if (entry['model'] !== undefined && entry['model'] !== 'inherit') {
      validateModelReference(entry['model'], `${entryPath}.model`);
    }
    projectAgentCapabilities(entry, entryPath);
  }
}

function validateLogger(value: AgentConfigDocument['logger']): void {
  if (value === undefined) return;
  try {
    validateLoggerConfig(value);
  } catch (error) {
    if (!(error instanceof LoggerConfigValidationError)) throw error;
    throw invalidAgentConfigField(
      error.fieldPath === undefined ? 'logger' : `logger.${error.fieldPath}`,
    );
  }
}

function validateExtensions(value: AgentConfigDocument['extensions']): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw invalidAgentConfigField('extensions');
  if (Object.hasOwn(value, 'enabled')) throw removedGlobalExtensionsSwitch();
  if (value.entries !== undefined && !isPlainObject(value.entries)) {
    throw invalidAgentConfigField('extensions.entries');
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateModelReference(value: unknown, fieldPath: string) {
  if (!isPlainObject(value)) throw invalidAgentConfigField(fieldPath);
  const providerId = typeof value['providerId'] === 'string' ? value['providerId'].trim() : '';
  const modelId = typeof value['modelId'] === 'string' ? value['modelId'].trim() : '';
  if (providerId.length === 0 || modelId.length === 0) {
    throw invalidAgentConfigField(fieldPath);
  }
  return { providerId, modelId };
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
