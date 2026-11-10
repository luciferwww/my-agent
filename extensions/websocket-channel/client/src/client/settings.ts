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
  return {
    id: section['id'], revision: section['revision'],
    name: typeof section['name'] === 'string' ? section['name'] : section['id'],
    settings: object(section['settings']), restartRequired: section['restartRequired'],
    ...(typeof section['applicationStatus'] === 'string' ? { applicationStatus: section['applicationStatus'] } : {}),
    fields, credentials,
    diagnostics: Array.isArray(section['diagnostics']) ? section['diagnostics'] : [],
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
