import type { AgentConfigDocument, AgentEntry, AgentExecutionConfig, ToolsConfig } from './types.js';
import { isDeepStrictEqual } from 'node:util';
import { isNamedAgentId } from '../../core/agent-context/index.js';
import { validateToolPolicyConfig, ToolPolicyConfigValidationError } from '../../core/tools/config.js';
import { getAgentExecutionSettings, readAgentConfigDocument, validateAgentConfigDocument, validateLlm } from './agent-config-loader.js';
import { RunnerConfigValidationError, validateRunnerConfig } from '../../core/runner/config.js';
import { SubagentDepthValidationError, validateMaxSubagentDepth } from '../../core/subagent/config.js';
import { parseCredentialEnvironmentReference } from './credential-materialization.js';
import { replaceAgentConfigFile } from './file-publication.js';
import { extensionSettingsFields, prepareExtensionConfig } from '../../extension/acquisition/configuration.js';
import { validateSkillSelection, SkillSelectionValidationError } from '../../core/skills/index.js';

export type CredentialChange =
  | { readonly operation: 'keep' }
  | { readonly operation: 'replace'; readonly value: string }
  | { readonly operation: 'clear' };

export type ConfigSectionEdit =
  | AgentPolicyEdit
  | AgentExecutionEdit
  | {
      readonly kind: 'llm';
      readonly settings: unknown;
      readonly credentials?: unknown;
    }
  | {
      readonly kind: 'extension';
      readonly extensionId: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly settings: unknown;
      readonly credentials?: unknown;
    };

export type AgentPolicyEdit =
  | { readonly kind: 'agent'; readonly agentId: string; readonly settings: unknown }
  | { readonly kind: 'agent-defaults'; readonly settings: unknown }
  | { readonly kind: 'agent-skills'; readonly settings: unknown };

export interface AgentExecutionEdit {
  readonly kind: 'agent-execution';
  readonly settings: unknown;
}

export type ConfigSectionPreimage =
  | { readonly kind: 'agent-policy'; readonly edit: AgentPolicyEdit }
  | { readonly kind: 'agent-execution'; readonly settings: Partial<AgentExecutionConfig> }
  | { readonly kind: 'llm'; readonly value: AgentConfigDocument['llm'] }
  | { readonly kind: 'extension'; readonly extensionId: string; readonly value: unknown; readonly present: boolean };

export class ConfigEditError extends Error {
  constructor(readonly fieldPath: string, message = 'Invalid editable configuration.') {
    super(message);
    this.name = 'ConfigEditError';
  }
}

export function editAgentConfigSection(
  document: AgentConfigDocument,
  edit: ConfigSectionEdit,
): { document: AgentConfigDocument; previous: ConfigSectionPreimage } {
  const settings = object(edit.settings, '/settings');
  if (edit.kind === 'agent-execution') {
    onlyKeys(settings, ['steeringEnabled', 'maxSubagentDepth', 'maxLlmCallsPerTurn'], '/settings');
    const runner = {
      ...(settings['steeringEnabled'] === undefined ? {} : { steeringEnabled: settings['steeringEnabled'] }),
      ...(settings['maxLlmCallsPerTurn'] === undefined ? {} : { maxLlmCallsPerTurn: settings['maxLlmCallsPerTurn'] }),
    };
    try {
      validateRunnerConfig(runner);
    } catch (error) {
      if (!(error instanceof RunnerConfigValidationError)) throw error;
      throw new ConfigEditError(`/settings/${error.fieldPath}`);
    }
    const depth = settings['maxSubagentDepth'];
    if (depth !== undefined) {
      try {
        validateMaxSubagentDepth(depth);
      } catch (error) {
        if (!(error instanceof SubagentDepthValidationError)) throw error;
        throw new ConfigEditError('/settings/maxSubagentDepth');
      }
    }
    const previous: ConfigSectionPreimage = { kind: 'agent-execution', settings: getAgentExecutionSettings(document) };
    const agents = { ...document.agents };
    delete agents.steeringEnabled;
    delete agents.maxLlmCallsPerTurn;
    delete agents.maxSubagentDepth;
    Object.assign(agents, runner, depth === undefined ? {} : { maxSubagentDepth: depth });
    const candidate = Object.keys(agents).length === 0 && document.agents === undefined
      ? document : { ...document, agents };
    validateAgentConfigDocument(candidate);
    return { document: candidate, previous };
  }
  if (edit.kind === 'agent' || edit.kind === 'agent-defaults' || edit.kind === 'agent-skills') {
    return editAgentPolicy(document, edit, settings);
  }
  if (edit.kind === 'llm') {
    onlyKeys(settings, ['builtin', 'defaultModel'], '/settings');
    const previous: ConfigSectionPreimage = { kind: 'llm', value: document.llm };
    const llm = { ...document.llm };
    delete llm.builtin;
    delete llm.defaultModel;
    if (settings['defaultModel'] !== undefined) {
      const reference = object(settings['defaultModel'], '/settings/defaultModel');
      onlyKeys(reference, ['providerId', 'modelId'], '/settings/defaultModel');
      if (typeof reference['providerId'] !== 'string' || typeof reference['modelId'] !== 'string') {
        throw new ConfigEditError('/settings/defaultModel');
      }
      llm.defaultModel = { providerId: reference['providerId'], modelId: reference['modelId'] };
    }
    const changes = credentialChanges(edit.credentials, ['/builtin/apiKey']);
    if (settings['builtin'] !== undefined) {
      const builtin = object(settings['builtin'], '/settings/builtin');
      onlyKeys(builtin, ['baseURL', 'models'], '/settings/builtin');
      const next = {
        ...(isObject(document.llm?.builtin) ? document.llm.builtin : {}),
        ...builtin,
        baseURL: builtin['baseURL'],
        models: mergeBuiltinModels(document.llm?.builtin, builtin['models']),
      };
      applyCredential(next, 'apiKey', changes['/builtin/apiKey']);
      llm.builtin = next;
    } else if (changes['/builtin/apiKey']?.operation === 'replace') {
      throw new ConfigEditError('/credentials/builtin/apiKey', 'A credential requires Built-in configuration.');
    }
    const candidate = { ...document, llm };
    validateLlm(candidate.llm);
    validateAgentConfigDocument(candidate);
    return { document: candidate, previous };
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(edit.extensionId)) {
    throw new ConfigEditError('/sectionId');
  }
  onlyKeys(settings, ['enabled', 'config'], '/settings');
  if (typeof settings['enabled'] !== 'boolean') throw new ConfigEditError('/settings/enabled');
  const fields = extensionSettingsFields(edit.schema);
  const incoming = object(settings['config'], '/settings/config');
  onlyKeys(incoming, fields.filter((field) => field.editable && !field.sensitive).map((field) => field.name), '/settings/config');
  const oldEntry = document.extensions?.entries?.[edit.extensionId];
  const previous: ConfigSectionPreimage = {
    kind: 'extension',
    extensionId: edit.extensionId,
    value: oldEntry,
    present: Object.hasOwn(document.extensions?.entries ?? {}, edit.extensionId),
  };
  const entry = oldEntry === undefined ? {} : object(oldEntry, '/settings');
  const config = entry['config'] === undefined ? {} : { ...object(entry['config'], '/settings/config') };
  const changes = credentialChanges(edit.credentials, fields.filter((field) => field.editable && field.sensitive).map((field) => field.path));
  for (const field of fields) {
    if (!field.editable) continue;
    if (field.sensitive) {
      applyCredential(config, field.name, changes[field.path]);
    } else {
      delete config[field.name];
      if (Object.hasOwn(incoming, field.name)) {
        Object.defineProperty(config, field.name, {
          value: structuredClone(incoming[field.name]), enumerable: true, configurable: true, writable: true,
        });
      }
    }
  }
  const validation = prepareExtensionConfig(config, edit.schema, {}, 'save');
  if (!validation.ok) {
    throw new ConfigEditError('/settings/config', 'Extension configuration does not satisfy its supported Schema.');
  }
  const candidate: AgentConfigDocument = {
    ...document,
    extensions: {
      ...document.extensions,
      entries: {
        ...document.extensions?.entries,
        [edit.extensionId]: { ...entry, enabled: settings['enabled'], config: validation.config },
      },
    },
  };
  validateAgentConfigDocument(candidate);
  validateLlm(candidate.llm);
  return { document: candidate, previous };
}

export async function saveAgentConfigSection(
  agentHome: string,
  edit: ConfigSectionEdit,
  beforeCommit?: (document: AgentConfigDocument) => void,
) {
  const current = await readAgentConfigDocument(agentHome);
  const committed = editAgentConfigSection(current, edit);
  beforeCommit?.(committed.document);
  if ((edit.kind !== 'agent' && edit.kind !== 'agent-defaults' && edit.kind !== 'agent-skills' && edit.kind !== 'agent-execution')
    || !isDeepStrictEqual(committed.document, current)) {
    await replaceAgentConfigFile(agentHome, `${JSON.stringify(committed.document, null, 2)}\n`);
  }
  return committed;
}

export async function restoreAgentConfigSection(
  agentHome: string,
  previous: ConfigSectionPreimage,
): Promise<AgentConfigDocument> {
  const current = await readAgentConfigDocument(agentHome);
  let restored: AgentConfigDocument;
  if (previous.kind === 'agent-execution') {
    restored = editAgentConfigSection(current, { kind: 'agent-execution', settings: previous.settings }).document;
  } else if (previous.kind === 'agent-policy') {
    restored = editAgentConfigSection(current, previous.edit).document;
  } else if (previous.kind === 'llm') {
    const document = { ...current };
    if (previous.value === undefined) delete document.llm;
    else document.llm = previous.value;
    restored = document;
  } else {
    const entries = { ...current.extensions?.entries };
    if (previous.present) entries[previous.extensionId] = previous.value;
    else delete entries[previous.extensionId];
    restored = { ...current, extensions: { ...current.extensions, entries } };
  }
  await replaceAgentConfigFile(agentHome, `${JSON.stringify(restored, null, 2)}\n`);
  return restored;
}

function editAgentPolicy(
  document: AgentConfigDocument,
  edit: AgentPolicyEdit,
  settings: Record<string, unknown>,
): { document: AgentConfigDocument; previous: ConfigSectionPreimage } {
  onlyKeys(settings, edit.kind === 'agent' ? ['enabled', 'tools', 'skills']
    : edit.kind === 'agent-skills' ? ['skills'] : ['tools'], '/settings');
  if (settings['enabled'] !== undefined && typeof settings['enabled'] !== 'boolean') {
    throw new ConfigEditError('/settings/enabled');
  }
  const incomingTools = settings['tools'];
  if (incomingTools !== undefined) {
    try {
      validateToolPolicyConfig(incomingTools);
    } catch (error) {
      if (!(error instanceof ToolPolicyConfigValidationError)) throw error;
      throw new ConfigEditError(`/settings/tools${error.fieldPath ? `/${error.fieldPath}` : ''}`);
    }
  }
  const tools: ToolsConfig | undefined = incomingTools === undefined ? undefined : structuredClone(incomingTools);
  const skills = settings['skills'];
  if (skills !== undefined) {
    try { validateSkillSelection(skills); } catch (error) {
      if (!(error instanceof SkillSelectionValidationError)) throw error;
      throw new ConfigEditError('/settings/skills', error.message);
    }
  }
  if (edit.kind === 'agent' && !isNamedAgentId(edit.agentId)) throw new ConfigEditError('/sectionId');
  const agents = document.agents;
  const savedSettings = edit.kind === 'agent-skills'
    ? getDefaultSkillSettings(document)
    : getAgentPolicySettings(document, edit.kind === 'agent' ? edit.agentId : undefined);
  const previousEdit: AgentPolicyEdit = { ...edit, settings: savedSettings };
  if (isDeepStrictEqual(savedSettings, settings)) {
    return { document, previous: { kind: 'agent-policy', edit: previousEdit } };
  }
  let candidate: AgentConfigDocument;
  if (edit.kind === 'agent-skills') {
    const defaults = { ...agents?.defaults };
    delete defaults.skills;
    if (skills !== undefined) defaults.skills = [...skills];
    candidate = Object.keys(defaults).length === 0 && agents?.defaults === undefined
      ? document : { ...document, agents: { ...agents, defaults } };
  } else if (edit.kind === 'agent-defaults') {
    const defaults = { ...agents?.defaults };
    const updated = replaceTools(defaults.tools, tools);
    if (updated === undefined) delete defaults.tools;
    else defaults.tools = updated;
    candidate = Object.keys(defaults).length === 0 && agents?.defaults === undefined
      ? document : { ...document, agents: { ...agents, defaults } };
  } else {
    const old = agents?.list?.find(entry => entry.id === edit.agentId);
    const entry: { -readonly [K in keyof AgentEntry]: AgentEntry[K] } = { ...old, id: edit.agentId };
    delete entry.enabled;
    if (settings['enabled'] === false) entry.enabled = false;
    const updated = replaceTools(entry.tools, tools);
    if (updated === undefined) delete entry.tools;
    else entry.tools = updated;
    delete entry.skills;
    if (skills !== undefined) entry.skills = [...skills];
    const list = [...agents?.list ?? []].filter(item => item.id !== edit.agentId);
    if (Object.keys(entry).some(key => key !== 'id')) {
      const index = old === undefined ? list.length : agents!.list!.indexOf(old);
      list.splice(index, 0, entry);
    }
    candidate = list.length === 0 && agents?.list === undefined ? document
      : { ...document, agents: { ...agents, list } };
  }
  validateAgentConfigDocument(candidate);
  return { document: candidate, previous: { kind: 'agent-policy', edit: previousEdit } };
}

export function getAgentPolicySettings(document: AgentConfigDocument, agentId?: string) {
  const entry = agentId === undefined ? undefined : document.agents?.list?.find(item => item.id === agentId);
  const tools = agentId === undefined ? document.agents?.defaults?.tools : entry?.tools;
  return {
    ...(entry?.enabled === undefined ? {} : { enabled: entry.enabled }),
    ...(entry?.skills === undefined ? {} : { skills: [...entry.skills] }),
    ...(tools === undefined ? {} : { tools: {
      ...(tools.allow === undefined ? {} : { allow: [...tools.allow] }),
      ...(tools.deny === undefined ? {} : { deny: [...tools.deny] }),
    } }),
  };
}

export function getDefaultSkillSettings(document: AgentConfigDocument) {
  const skills = document.agents?.defaults?.skills;
  return skills === undefined ? {} : { skills: [...skills] };
}

function replaceTools(previous: ToolsConfig | undefined, incoming: ToolsConfig | undefined): ToolsConfig | undefined {
  const next = { ...previous };
  delete next.allow;
  delete next.deny;
  if (incoming?.allow !== undefined) next.allow = [...incoming.allow];
  if (incoming?.deny !== undefined) next.deny = [...incoming.deny];
  return Object.keys(next).length === 0 ? undefined : next;
}

function credentialChanges(input: unknown, paths: readonly string[]): Record<string, CredentialChange> {
  if (input === undefined) return {};
  const changes = object(input, '/credentials');
  onlyKeys(changes, paths, '/credentials');
  return Object.fromEntries(Object.entries(changes).map(([path, value]) => {
    const change = object(value, '/credentials');
    onlyKeys(change, change['operation'] === 'replace' ? ['operation', 'value'] : ['operation'], '/credentials');
    if (change['operation'] === 'replace') {
      if (typeof change['value'] !== 'string' || change['value'].trim().length === 0) {
        throw new ConfigEditError('/credentials', 'Use clear to remove a credential.');
      }
      parseCredentialEnvironmentReference(change['value']);
      return [path, { operation: 'replace', value: change['value'] }];
    }
    if (change['operation'] !== 'keep' && change['operation'] !== 'clear') {
      throw new ConfigEditError('/credentials');
    }
    return [path, { operation: change['operation'] }];
  }));
}

function mergeBuiltinModels(previous: unknown, input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const models = isObject(previous) && Array.isArray(previous['models']) ? previous['models'] : [];
  const retained = new Map(
    models.filter(isObject).map((model) => [model['modelId'], model]),
  );
  const unopenedFields = ['maximumContextTokens', 'maximumPromptTokens', 'maximumOutputTokens', 'outputTokenLimit', 'reasoning'];
  return input.map((model: unknown) => {
    if (!isObject(model)) return model;
    const old = retained.get(model['modelId']);
    return {
      ...Object.fromEntries(Object.entries(old ?? {}).filter(([key]) => unopenedFields.includes(key))),
      ...model,
    };
  });
}

function applyCredential(target: Record<string, unknown>, key: string, change?: CredentialChange): void {
  if (!change || change.operation === 'keep') return;
  if (change.operation === 'clear') delete target[key];
  else Object.defineProperty(target, key, {
    value: change.value, enumerable: true, configurable: true, writable: true,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new ConfigEditError(path);
  return value;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ConfigEditError(path);
}
