import { isDeepStrictEqual } from 'node:util';
import {
  getAgentExecutionSettings, resolveAgentExecutionConfig, validateLlmConfiguration,
  resolveMemoryConfig,
} from '../../platform/config/index.js';
import type { AgentConfigDocument, AgentExecutionConfig } from '../../platform/config/types.js';
import {
  CredentialMaterializationError,
  parseCredentialEnvironmentReference,
} from '../../platform/config/credential-materialization.js';
import {
  extensionSettingsFields,
  prepareExtensionConfig,
} from '../../extension/acquisition/configuration.js';
import type {
  ExtensionAcquisitionDiagnostic,
  ExtensionDescriptorV1,
} from '../../extension/acquisition/types.js';
import { isObject } from './helpers.js';

export type SettingsApplicationState = 'current' | 'not_applied' | 'unknown';

export function buildMemorySectionView(input: {
  readonly revision: string | undefined;
  readonly document: AgentConfigDocument;
  readonly startupEnabled: boolean;
}) {
  const enabled = resolveMemoryConfig(input.document.agents?.memory).enabled;
  const restartRequired = enabled !== input.startupEnabled;
  return {
    id: 'agents:memory', kind: 'memory', name: 'Memory', revision: input.revision,
    settings: { enabled }, restartRequired,
    applicationStatus: restartRequired ? 'restart_required' : 'current',
    form: { credentials: {} },
  };
}

export function buildExecutionSectionView(input: {
  readonly revision: string | undefined;
  readonly document: AgentConfigDocument;
  readonly applied: AgentExecutionConfig;
}) {
  const settings = getAgentExecutionSettings(input.document);
  const resolvedSettings = resolveAgentExecutionConfig(settings);
  return {
    id: 'agents:execution', kind: 'agent-execution', name: 'Execution policy',
    revision: input.revision, settings, defaults: resolveAgentExecutionConfig(),
    resolvedSettings, restartRequired: false,
    applicationStatus: isDeepStrictEqual(resolvedSettings, resolveAgentExecutionConfig(input.applied))
      ? 'current' : 'not_applied',
    form: { credentials: {} },
  };
}

export function buildLlmSectionView(input: {
  readonly id: string;
  readonly revision: string | undefined;
  readonly llm: AgentConfigDocument['llm'];
  readonly applicationStatus: SettingsApplicationState;
}) {
  const llm = validateLlmConfiguration(input.llm);
  const { apiKey, ...builtin } = llm.builtin ?? {};
  return {
    id: input.id, revision: input.revision, restartRequired: false,
    applicationStatus: input.applicationStatus,
    settings: {
      ...(llm.defaultModel === undefined ? {} : { defaultModel: llm.defaultModel }),
      ...(llm.builtin === undefined ? {} : { builtin }),
    },
    form: { credentials: { '/builtin/apiKey': credentialMetadata(apiKey) } },
  };
}

export function buildExtensionSectionView(input: {
  readonly id: string;
  readonly revision: string | undefined;
  readonly entry: unknown;
  readonly baseline: unknown;
  readonly descriptor: ExtensionDescriptorV1;
  readonly diagnostics: readonly ExtensionAcquisitionDiagnostic[];
}) {
  const { id, revision, entry, baseline, descriptor } = input;
  const config = isObject(entry) && isObject(entry['config']) ? entry['config'] : {};
  const fields = extensionSettingsFields(descriptor.configSchema);
  const settings = Object.fromEntries(fields.filter((field) => field.editable && !field.sensitive
    && Object.hasOwn(config, field.name) && isScalar(config[field.name]))
    .map((field) => [field.name, config[field.name]]));
  const credentials = Object.fromEntries(fields.filter((field) => field.editable && field.sensitive)
    .map((field) => [field.path, credentialMetadata(Object.hasOwn(config, field.name) ? config[field.name] : undefined)]));
  const restartRequired = !isDeepStrictEqual(
    comparisonEntry(entry, descriptor), comparisonEntry(baseline, descriptor),
  );
  return {
    id, name: descriptor.name ?? descriptor.id, revision, restartRequired,
    applicationStatus: restartRequired ? 'restart_required' : 'current',
    settings: { enabled: !isObject(entry) || entry['enabled'] !== false, config: settings },
    form: { fields, credentials },
    diagnostics: input.diagnostics.filter((diagnostic) => diagnostic.extensionId === descriptor.id),
  };
}

function credentialMetadata(value: unknown) {
  if (value === undefined || typeof value === 'string' && value.trim().length === 0) return { configured: false };
  try {
    return { configured: true, source: parseCredentialEnvironmentReference(value) === undefined ? 'literal' : 'environment' };
  } catch (error) {
    if (!(error instanceof CredentialMaterializationError)) throw error;
    return { configured: true, error: 'invalid_credential' };
  }
}

function comparisonEntry(entry: unknown, descriptor: ExtensionDescriptorV1): unknown {
  if (entry !== undefined && !isObject(entry)) return { invalid: true, value: entry };
  const config = entry?.['config'] ?? {};
  const validation = isObject(config) ? prepareExtensionConfig(config, descriptor.configSchema, {}, 'save') : undefined;
  return {
    enabled: entry?.['enabled'] !== false,
    config: validation?.ok ? validation.config : { invalid: true, value: config },
  };
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}
