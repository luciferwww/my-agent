import type { AgentConfigDocument } from './types.js';
import { readAgentConfigDocument, validateAgentConfigDocument, validateLlm } from './agent-config-loader.js';
import { parseCredentialEnvironmentReference } from './credential-materialization.js';
import { replaceAgentConfigFile } from './file-publication.js';
import { extensionSettingsFields, prepareExtensionConfig } from '../../extension/acquisition/configuration.js';

export type CredentialChange =
  | { readonly operation: 'keep' }
  | { readonly operation: 'replace'; readonly value: string }
  | { readonly operation: 'clear' };

export type ConfigSectionEdit =
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

export type ConfigSectionPreimage =
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
  await replaceAgentConfigFile(agentHome, `${JSON.stringify(committed.document, null, 2)}\n`);
  return committed;
}

export async function restoreAgentConfigSection(
  agentHome: string,
  previous: ConfigSectionPreimage,
): Promise<AgentConfigDocument> {
  const current = await readAgentConfigDocument(agentHome);
  let restored: AgentConfigDocument;
  if (previous.kind === 'llm') {
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
