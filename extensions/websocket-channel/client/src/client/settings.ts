import type { SettingsActionResult } from 'my-agent/extension-api';

export class SettingsRequests {
  private nextId = 1;
  private readonly pending = new Map<string, {
    action: string;
    resolve: (result: SettingsActionResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly send: (message: unknown) => void) {}

  execute(action: string, input: unknown): Promise<SettingsActionResult> {
    const requestId = `settings-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(requestId, {
          requestId, action, ok: false,
          error: {
            code: 'request_timeout',
            message: 'No Settings response arrived. The operation may have completed; reload before saving again.',
          },
        });
      }, 60_000);
      this.pending.set(requestId, { action, resolve, timer });
      try {
        this.send({ type: 'settings_action', requestId, action, input });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  receive(message: Record<string, unknown>): boolean {
    const id = message['requestId'];
    if (typeof id !== 'string') return false;
    const pending = this.pending.get(id);
    if (!pending || message['action'] !== pending.action) return false;
    if (message['ok'] === true) {
      this.settle(id, { requestId: id, action: pending.action, ok: true, output: message['output'] });
    } else {
      const error = object(message['error']);
      if (message['ok'] !== false || typeof error['code'] !== 'string' || typeof error['message'] !== 'string') {
        throw new Error('Malformed Settings result.');
      }
      this.settle(id, {
        requestId: id, action: pending.action, ok: false, output: message['output'],
        error: {
          code: error['code'], message: error['message'],
          ...(typeof error['fieldPath'] === 'string' ? { fieldPath: error['fieldPath'] } : {}),
        },
      });
    }
    return true;
  }

  interrupt(reason: 'connection_lost' | 'invalid_response' = 'connection_lost'): void {
    for (const [requestId, pending] of this.pending) {
      this.settle(requestId, {
        requestId, action: pending.action, ok: false,
        error: {
          code: reason,
          message: `${reason === 'connection_lost' ? 'Connection lost.' : 'Invalid Settings response.'} The operation may have completed; reload saved settings before saving again.`,
        },
      });
    }
  }

  private settle(id: string, result: SettingsActionResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result);
  }
}

export interface SettingsField {
  name: string;
  path: string;
  supported: boolean;
  editable: boolean;
  sensitive: boolean;
  schema?: Record<string, unknown>;
}

export interface CredentialMetadata {
  configured: boolean;
  source?: string;
  error?: string;
}

export const SAVED_CREDENTIAL_MASK = '******';

export interface SecretDraft {
  operation: 'keep' | 'replace' | 'clear';
  value: string;
}

export function credentialDraft(value: string, configured: boolean): SecretDraft {
  if (configured && value === SAVED_CREDENTIAL_MASK) return { operation: 'keep', value: '' };
  if (value === '') return { operation: 'clear', value: '' };
  return { operation: 'replace', value };
}

export interface SettingsSection {
  id: string;
  revision: string;
  name: string;
  settings: Record<string, unknown>;
  restartRequired: boolean;
  applicationStatus?: string;
  fields: SettingsField[];
  credentials: Record<string, CredentialMetadata>;
  diagnostics: unknown[];
  agent?: AgentSettingsView;
  skills?: { shared: string[]; effective: string[] };
  execution?: {
    defaults: ExecutionSettings;
    resolved: ExecutionSettings;
  };
}

export interface ExecutionSettings {
  steeringEnabled: boolean;
  maxSubagentDepth: number;
  maxLlmCallsPerTurn?: number;
}

function parseExecutionSettings(value: unknown, complete: true): ExecutionSettings;
function parseExecutionSettings(value: unknown, complete?: false): Partial<ExecutionSettings>;
function parseExecutionSettings(value: unknown, complete = false): Partial<ExecutionSettings> {
  const settings = object(value);
  const steering = settings['steeringEnabled'];
  const depth = settings['maxSubagentDepth'];
  const calls = settings['maxLlmCallsPerTurn'];
  if (Object.keys(settings).some(key => !['steeringEnabled', 'maxSubagentDepth', 'maxLlmCallsPerTurn'].includes(key))
    || (steering !== undefined && typeof steering !== 'boolean')
    || (complete && typeof steering !== 'boolean')
    || (depth !== undefined && (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0))
    || (complete && typeof depth !== 'number')
    || (calls !== undefined && (typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls <= 0))) {
    throw new Error('Invalid execution policy: expected a boolean, a non-negative integer depth and an optional positive integer call limit.');
  }
  return {
    ...(typeof steering === 'boolean' ? { steeringEnabled: steering } : {}),
    ...(typeof depth === 'number' ? { maxSubagentDepth: depth } : {}),
    ...(typeof calls === 'number' ? { maxLlmCallsPerTurn: calls } : {}),
  };
}

export function executionPolicySettings(draft: Record<string, unknown>): Partial<ExecutionSettings> {
  const values = { ...draft };
  for (const key of ['maxSubagentDepth', 'maxLlmCallsPerTurn']) {
    const value = values[key];
    if (typeof value !== 'string') continue;
    if (!value.trim()) throw new Error(`${key} requires an integer.`);
    values[key] = Number(value);
  }
  return parseExecutionSettings(values);
}

export interface AgentSettingsView {
  builtIn: boolean;
  enabled: boolean;
  description?: string;
  model?: 'inherit' | { providerId: string; modelId: string };
  modelAvailable?: boolean;
  definitionAvailable: boolean;
  sharedAllow: string[];
  sharedDeny: string[];
  sharedDeniedTools: string[];
  contextFiles: { path: string; content: string }[];
  instructionFiles: { path: string; content: string }[];
  missingFiles: string[];
  metadata: Record<string, unknown>;
}

export function agentPolicySettings(
  section: SettingsSection,
  draft: { enabled: boolean; allowMode: 'inherit' | 'explicit'; allow: string; deny: string },
): Record<string, unknown> {
  if (!section.agent) throw new Error('Expected Agent settings.');
  const saved = section.settings['tools'] === undefined ? {} : object(section.settings['tools']);
  const tools = { ...saved };
  if (draft.allowMode === 'inherit') delete tools['allow'];
  else tools['allow'] = toolPatterns(draft.allow);
  const deny = toolPatterns(draft.deny);
  if (JSON.stringify(deny) !== JSON.stringify(saved['deny'] ?? [])) {
    if (deny.length) tools['deny'] = deny;
    else delete tools['deny'];
  }
  return {
    ...(!section.agent.builtIn && !draft.enabled ? { enabled: false } : {}),
    ...(section.settings['skills'] === undefined ? {} : { skills: stringList(section.settings['skills']) }),
    ...(Object.keys(tools).length ? { tools } : {}),
  };
}

function toolPatterns(value: string): string[] {
  return value.split(/\r?\n/u).filter(Boolean);
}

export interface SettingsTool {
  name: string;
  description: string;
}

export interface SettingsSkill {
  name: string;
  description: string;
  relativeDirectory: string;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('Malformed Skills selection.');
  }
  return value;
}

export function settingsSkills(value: unknown): { entries: SettingsSkill[]; diagnostics: unknown[] } {
  const catalog = object(value);
  if (!Array.isArray(catalog['entries']) || !Array.isArray(catalog['diagnostics'])) {
    throw new Error('Malformed Skill Catalog.');
  }
  return {
    entries: catalog['entries'].map(value => {
      const entry = object(value);
      if (typeof entry['name'] !== 'string' || typeof entry['description'] !== 'string'
        || typeof entry['relativeDirectory'] !== 'string') throw new Error('Malformed Skill Catalog entry.');
      return { name: entry['name'], description: entry['description'], relativeDirectory: entry['relativeDirectory'] };
    }),
    diagnostics: catalog['diagnostics'],
  };
}

export function settingsTools(value: unknown): SettingsTool[] {
  if (!Array.isArray(value)) throw new Error('Malformed Tool Catalog.');
  return value.map(value => {
    const tool = object(value);
    if (typeof tool['name'] !== 'string' || typeof tool['description'] !== 'string') {
      throw new Error('Malformed Tool Catalog entry.');
    }
    return { name: tool['name'], description: tool['description'] };
  });
}

export interface SettingsProvider {
  providerId: string;
  name: string;
  configurationSectionId?: string;
  models: { modelId: string; name: string }[];
}

export function settingsProviders(value: unknown): SettingsProvider[] {
  const catalog = object(value);
  if (!Array.isArray(catalog['providers'])) throw new Error('Malformed Model Catalog.');
  return catalog['providers'].map((value: unknown) => {
    const provider = object(value);
    if (typeof provider['providerId'] !== 'string' || !Array.isArray(provider['models'])
      || (provider['configurationSectionId'] !== undefined && typeof provider['configurationSectionId'] !== 'string')) {
      throw new Error('Malformed Provider.');
    }
    return {
      providerId: provider['providerId'],
      name: typeof provider['displayName'] === 'string' ? provider['displayName'] : provider['providerId'],
      configurationSectionId: provider['configurationSectionId'],
      models: provider['models'].map((value: unknown) => {
        const model = object(value);
        if (typeof model['modelId'] !== 'string') throw new Error('Malformed catalog model.');
        return { modelId: model['modelId'], name: typeof model['displayName'] === 'string' ? model['displayName'] : model['modelId'] };
      }),
    };
  });
}

export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error('Malformed Settings data.');
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSection(value: unknown): SettingsSection {
  const section = object(value);
  if (typeof section['id'] !== 'string' || typeof section['revision'] !== 'string'
    || typeof section['restartRequired'] !== 'boolean') throw new Error('Malformed Settings section.');
  const form = object(section['form']);
  const credentials = Object.fromEntries(Object.entries(object(form['credentials'])).map(([path, value]) => {
    const metadata = object(value);
    if (typeof metadata['configured'] !== 'boolean') throw new Error('Malformed credential metadata.');
    return [path, {
      configured: metadata['configured'],
      ...(typeof metadata['source'] === 'string' ? { source: metadata['source'] } : {}),
      ...(typeof metadata['error'] === 'string' ? { error: metadata['error'] } : {}),
    }];
  }));
  const rawFields = form['fields'] ?? [];
  if (!Array.isArray(rawFields)) throw new Error('Malformed Settings fields.');
  const fields: SettingsField[] = rawFields.map((value: unknown) => {
    const field = object(value);
    if (typeof field['name'] !== 'string' || typeof field['path'] !== 'string'
      || typeof field['editable'] !== 'boolean' || typeof field['supported'] !== 'boolean'
      || typeof field['sensitive'] !== 'boolean') throw new Error('Malformed Settings field.');
    return {
      name: field['name'], path: field['path'], supported: field['supported'],
      editable: field['editable'], sensitive: field['sensitive'],
      ...(field['schema'] === undefined ? {} : { schema: object(field['schema']) }),
    };
  });
  const execution = section['id'] === 'agents:execution';
  if (section['id'] === 'agents:memory') {
    const settings = object(section['settings']);
    if (section['kind'] !== 'memory' || typeof settings['enabled'] !== 'boolean'
      || Object.keys(settings).some(key => key !== 'enabled')) {
      throw new Error('Malformed Memory Settings section.');
    }
  }
  if (execution && section['kind'] !== 'agent-execution') throw new Error('Malformed execution Settings section.');
  if (section['effectiveSkills'] !== undefined) {
    stringList(section['effectiveSkills']);
    const settings = object(section['settings']);
    if (settings['skills'] !== undefined) stringList(settings['skills']);
  }
  return {
    id: section['id'], revision: section['revision'],
    name: typeof section['name'] === 'string' ? section['name'] : section['id'],
    settings: execution ? parseExecutionSettings(section['settings']) : object(section['settings']),
    restartRequired: section['restartRequired'],
    ...(typeof section['applicationStatus'] === 'string' ? { applicationStatus: section['applicationStatus'] } : {}),
    fields, credentials,
    diagnostics: Array.isArray(section['diagnostics']) ? section['diagnostics'] : [],
    ...(section['effectiveSkills'] === undefined ? {} : { skills: {
      effective: stringList(section['effectiveSkills']),
      shared: section['kind'] === 'agent-skills' ? [] : stringList(section['sharedSkills']),
    } }),
    ...(execution ? { execution: {
      defaults: parseExecutionSettings(section['defaults'], true),
      resolved: parseExecutionSettings(section['resolvedSettings'], true),
    } } : {}),
    ...(section['kind'] === 'agent' || section['kind'] === 'agent-defaults'
      ? { agent: parseAgentView(section) } : {}),
  };
}

function parseAgentView(section: Record<string, unknown>): AgentSettingsView {
  const builtIn = section['kind'] === 'agent-defaults';
  if (typeof section['enabled'] !== 'boolean'
    || (!builtIn && typeof section['definitionAvailable'] !== 'boolean')) {
    throw new Error('Malformed Agent settings.');
  }
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Malformed Agent Tool or file list.');
    return value;
  };
  const files = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error('Malformed Agent Context.');
    return value.map(value => {
      const file = object(value);
      if (typeof file['path'] !== 'string' || typeof file['content'] !== 'string') throw new Error('Malformed Agent Context file.');
      return { path: file['path'], content: file['content'] };
    });
  };
  const reference = section['model'] === undefined || section['model'] === 'inherit'
    ? section['model'] : object(section['model']);
  if (reference !== undefined && reference !== 'inherit'
    && (typeof reference['providerId'] !== 'string' || typeof reference['modelId'] !== 'string')) {
    throw new Error('Malformed Agent model reference.');
  }
  const model = reference === undefined || reference === 'inherit' ? reference
    : { providerId: String(reference['providerId']), modelId: String(reference['modelId']) };
  const settings = object(section['settings']);
  if (settings['tools'] !== undefined) {
    const tools = object(settings['tools']);
    if (tools['allow'] !== undefined) strings(tools['allow']);
    if (tools['deny'] !== undefined) strings(tools['deny']);
  }
  return {
    builtIn, enabled: section['enabled'],
    definitionAvailable: builtIn || section['definitionAvailable'] === true,
    description: typeof section['description'] === 'string' ? section['description'] : undefined,
    model,
    modelAvailable: typeof section['modelAvailable'] === 'boolean' ? section['modelAvailable'] : undefined,
    sharedAllow: builtIn ? [] : strings(section['sharedAllow']),
    sharedDeny: builtIn ? [] : strings(section['sharedDeny']),
    sharedDeniedTools: builtIn ? [] : strings(section['sharedDeniedTools']),
    contextFiles: builtIn ? [] : files(section['contextFiles']),
    instructionFiles: builtIn ? [] : files(section['instructionFiles']),
    missingFiles: builtIn ? [] : strings(section['missingFiles']),
    metadata: builtIn ? {} : object(section['metadata']),
  };
}

export interface ModelDraft {
  modelId: string;
  protocol: string;
  displayName: string;
  endpoint: string;
  advanced: string;
}

export function modelDraft(value: unknown): ModelDraft {
  const { modelId, protocol, displayName, endpoint, ...advanced } = object(value);
  if (typeof modelId !== 'string' || typeof protocol !== 'string') throw new Error('Malformed Built-in model.');
  return {
    modelId, protocol, displayName: typeof displayName === 'string' ? displayName : '',
    endpoint: typeof endpoint === 'string' ? endpoint : '',
    advanced: JSON.stringify(advanced, null, 2),
  };
}

export function modelSettings(model: ModelDraft): Record<string, unknown> {
  const advanced = object(JSON.parse(model.advanced));
  return {
    ...advanced, modelId: model.modelId, protocol: model.protocol,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    ...(model.endpoint ? { endpoint: model.endpoint } : {}),
  };
}
