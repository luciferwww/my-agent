import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedHostExtensionsConfig } from '../../extension/acquisition/types.js';
import {
  BuiltinLlmConfigError,
  validateBuiltinLlmProviderConfig,
  type LLMConfig,
} from '../../builtins/providers/builtin/index.js';
import { DEFAULT_RUNNER_CONFIG } from '../../core/runner/config.js';
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
  unavailableConfigSecret,
  unknownAgentConfigNamespace,
} from './agent-config-errors.js';
import {
  CredentialMaterializationError,
  materializeExactStringCredential,
} from './credential-materialization.js';
import { validateAgentLeafConfig, validateRunnerConfigSection } from './agent-leaf-validation.js';
import type {
  AgentConfigDocument,
  AgentsConfig,
  ApplicationConfigProjection,
} from './types.js';

const CONFIG_FILE_NAME = 'config.json';
const TOP_LEVEL_NAMESPACES = new Set([
  'llm',
  'agents',
  'logger',
  'extensions',
]);

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
  readonly environment?: Readonly<Record<string, string | undefined>>;
}, dependencies: AgentConfigLoaderDependencies = DEFAULT_DEPENDENCIES): Promise<AgentConfigSnapshot> {
  const document = await readAgentConfigDocument(options.agentHome, dependencies);
  const llm = validateLlm(document.llm, options.environment ?? process.env);
  validateAgentConfigDocument(document);
  const runner = {
    steeringEnabled:
      document.agents?.steeringEnabled ?? DEFAULT_RUNNER_CONFIG.steeringEnabled,
    ...(document.agents?.maxLlmCallsPerTurn === undefined
      ? {}
      : { maxLlmCallsPerTurn: document.agents.maxLlmCallsPerTurn }),
  };

  const defaultAgentConfig = createDefaultAgentConfig();
  const defaults = document.agents?.defaults === undefined
    ? defaultAgentConfig
    : deepMerge(
        defaultAgentConfig,
        structuredClone(document.agents.defaults),
      );
  validateAgentLeafConfig(defaults, 'agents.defaults');
  for (const [index, entry] of (document.agents?.list ?? []).entries()) {
    const {
      id: _id,
      description: _description,
      default: _default,
      model: _model,
      ...overrides
    } = entry;
    validateAgentLeafConfig(
      deepMerge(structuredClone(defaults), structuredClone(overrides)),
      `agents.list[${index}]`,
    );
  }
  const agents: AgentsConfig = {
    ...runner,
    maxSubagentDepth:
      document.agents?.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
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
    application: { llm, agents, logger },
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

function validateLlm(
  value: AgentConfigDocument['llm'],
  environment: Readonly<Record<string, string | undefined>>,
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
      const apiKey = materializeExactStringCredential(builtin.apiKey, environment);
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
  for (const field of Object.keys(value)) {
    if (
      field !== 'steeringEnabled'
      && field !== 'maxLlmCallsPerTurn'
      && field !== 'maxSubagentDepth'
      && field !== 'defaults'
      && field !== 'list'
    ) {
      throw invalidAgentConfigField(`agents.${field}`);
    }
  }
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
    if ('model' in value.defaults) {
      throw invalidAgentConfigField('agents.defaults.model');
    }
    if ('llm' in value.defaults) {
      throw invalidAgentConfigField('agents.defaults.llm');
    }
    if ('workspace' in value.defaults) {
      throw invalidAgentConfigField('agents.defaults.workspace');
    }
    if ('prompt' in value.defaults) {
      throw invalidAgentConfigField('agents.defaults.prompt');
    }
    if ('subagents' in value.defaults) {
      throw invalidAgentConfigField('agents.defaults.subagents');
    }
    rejectGlobalPolicyConfig(value.defaults, 'agents.defaults');
    rejectRetiredToolsConfig(value.defaults, 'agents.defaults');
    rejectUnknownFields(
      value.defaults,
      new Set(['memory', 'tools', 'context', 'compaction']),
      'agents.defaults',
    );
    validateAgentLeafConfig(value.defaults, 'agents.defaults');
  }
  if (value.list === undefined) return;
  if (!Array.isArray(value.list)) throw invalidAgentConfigField('agents.list');
  for (const [index, entry] of value.list.entries()) {
    const entryPath = `agents.list[${index}]`;
    if (!isPlainObject(entry)) throw invalidAgentConfigField(entryPath);
    if (typeof entry['id'] !== 'string' || entry['id'].trim().length === 0) {
      throw invalidAgentConfigField(`${entryPath}.id`);
    }
    if (
      typeof entry['description'] !== 'string'
      || entry['description'].trim().length === 0
    ) {
      throw invalidAgentConfigField(`${entryPath}.description`);
    }
    if (entry['default'] !== undefined && typeof entry['default'] !== 'boolean') {
      throw invalidAgentConfigField(`${entryPath}.default`);
    }
    if ('workspace' in entry) {
      throw invalidAgentConfigField(`${entryPath}.workspace`);
    }
    if (entry['model'] !== undefined) {
      validateModelReference(entry['model'], `${entryPath}.model`);
      const model = entry['model'] as Readonly<Record<string, unknown>>;
      const unknownModelField = Object.keys(model).find(
        (field) => field !== 'providerId' && field !== 'modelId',
      );
      if (unknownModelField !== undefined) {
        throw invalidAgentConfigField(`${entryPath}.model.${unknownModelField}`);
      }
    }
    if ('maxLlmCalls' in entry) {
      throw invalidAgentConfigField(`${entryPath}.maxLlmCalls`);
    }
    if ('llm' in entry) {
      throw invalidAgentConfigField(`${entryPath}.llm`);
    }
    if ('prompt' in entry) {
      throw invalidAgentConfigField(`${entryPath}.prompt`);
    }
    if ('subagents' in entry) {
      throw invalidAgentConfigField(`${entryPath}.subagents`);
    }
    rejectGlobalPolicyConfig(entry, entryPath);
    rejectRetiredToolsConfig(entry, entryPath);
    rejectUnknownFields(
      entry,
      new Set([
        'id',
        'description',
        'default',
        'model',
        'memory',
        'tools',
        'context',
        'compaction',
      ]),
      entryPath,
    );
    validateAgentLeafConfig(entry, entryPath);
  }

  function rejectGlobalPolicyConfig(
    value: Readonly<Record<string, unknown>>,
    fieldPath: string,
  ): void {
    if ('runtime' in value) throw invalidAgentConfigField(`${fieldPath}.runtime`);
    if ('runner' in value) throw invalidAgentConfigField(`${fieldPath}.runner`);
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
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw invalidAgentConfigField('extensions.enabled');
  }
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

function rejectRetiredToolsConfig(
  value: Readonly<Record<string, unknown>>,
  fieldPath: string,
): void {
  const tools = value['tools'];
  if (isPlainObject(tools) && 'fs' in tools) {
    throw invalidAgentConfigField(`${fieldPath}.tools.fs`);
  }
}

function rejectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlySet<string>,
  fieldPath: string,
): void {
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    throw invalidAgentConfigField(`${fieldPath}.${unknownField}`);
  }
}