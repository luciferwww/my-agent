import { Ajv, type ValidateFunction } from 'ajv/dist/ajv.js';

import type {
  ExtensionLoaderDiagnosticCategory,
  ExtensionLoaderDiagnosticCode,
} from './types.js';

const MAX_DIAGNOSTIC_FIELD_LENGTH = 200;

export type ExtensionConfigPreparationResult =
  | Readonly<{
      ok: true;
      config: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      category: Extract<ExtensionLoaderDiagnosticCategory, 'config_invalid' | 'secret_unavailable'>;
      code: Extract<
        ExtensionLoaderDiagnosticCode,
        | 'environment_value_unavailable'
        | 'environment_secret_unavailable'
        | 'config_schema_invalid'
        | 'config_validation_failed'
      >;
      referencePath?: string;
      environmentVariable?: string;
    }>;

interface ConfigReferenceFailure {
  readonly category: Extract<ExtensionLoaderDiagnosticCategory, 'config_invalid' | 'secret_unavailable'>;
  readonly code: Extract<
    ExtensionLoaderDiagnosticCode,
    'environment_value_unavailable' | 'environment_secret_unavailable'
  >;
  readonly referencePath: string;
  readonly environmentVariable: string;
}

export function prepareExtensionConfig(
  input: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
): ExtensionConfigPreparationResult {
  let config: Record<string, unknown>;
  try {
    config = cloneJsonObject(input);
  } catch {
    return configFailure('config_invalid', 'config_validation_failed');
  }

  const referenceFailure = materializeConfigValue(config, environment, '');
  if (referenceFailure !== undefined) {
    return Object.freeze({ ok: false, ...referenceFailure });
  }

  let validate: ValidateFunction;
  try {
    const ajv = new Ajv({
      strict: true,
      allErrors: true,
      useDefaults: true,
      coerceTypes: false,
      removeAdditional: false,
    });
    validate = ajv.compile(cloneJsonObject(schema));
  } catch {
    return configFailure('config_invalid', 'config_schema_invalid');
  }

  if (validate(config) !== true) {
    return configFailure('config_invalid', 'config_validation_failed');
  }

  return Object.freeze({
    ok: true,
    config: deepFreeze(config),
  });
}

function materializeConfigValue(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
): ConfigReferenceFailure | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const childPath = appendPointer(path, String(index));
      const child = value[index];
      const replacement = resolveReference(child, environment, childPath);
      if (isReferenceFailure(replacement)) return replacement;
      if (replacement !== undefined) value[index] = replacement;
      else {
        const failure = materializeConfigValue(child, environment, childPath);
        if (failure !== undefined) return failure;
      }
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;

  for (const [key, child] of Object.entries(value)) {
    const childPath = appendPointer(path, key);
    const replacement = resolveReference(child, environment, childPath);
    if (isReferenceFailure(replacement)) return replacement;
    if (replacement !== undefined) value[key] = replacement;
    else {
      const failure = materializeConfigValue(child, environment, childPath);
      if (failure !== undefined) return failure;
    }
  }
  return undefined;
}

function resolveReference(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
): string | ConfigReferenceFailure | undefined {
  if (isExactEnvironmentValueReference(value)) {
    const environmentValue = environment[value.$env];
    if (environmentValue !== undefined) return environmentValue;
    return referenceFailure(
      'config_invalid',
      'environment_value_unavailable',
      path,
      value.$env,
    );
  }
  if (isExactEnvironmentSecretReference(value)) {
    const environmentValue = environment[value.$secret.name];
    if (environmentValue !== undefined) return environmentValue;
    return referenceFailure(
      'secret_unavailable',
      'environment_secret_unavailable',
      path,
      value.$secret.name,
    );
  }
  return undefined;
}

function isExactEnvironmentValueReference(
  value: unknown,
): value is Readonly<{ $env: string }> {
  return isPlainObject(value)
    && hasExactKeys(value, ['$env'])
    && typeof value['$env'] === 'string';
}

function isExactEnvironmentSecretReference(
  value: unknown,
): value is Readonly<{
  $secret: Readonly<{ source: 'env'; name: string }>;
}> {
  if (!isPlainObject(value) || !hasExactKeys(value, ['$secret'])) return false;
  const secret = value['$secret'];
  return isPlainObject(secret)
    && hasExactKeys(secret, ['source', 'name'])
    && secret['source'] === 'env'
    && typeof secret['name'] === 'string';
}

function referenceFailure(
  category: ConfigReferenceFailure['category'],
  code: ConfigReferenceFailure['code'],
  path: string,
  environmentVariable: string,
): ConfigReferenceFailure {
  return Object.freeze({
    category,
    code,
    referencePath: boundField(path || '/'),
    environmentVariable: boundField(environmentVariable),
  });
}

function configFailure(
  category: 'config_invalid',
  code: 'config_schema_invalid' | 'config_validation_failed',
): ExtensionConfigPreparationResult {
  return Object.freeze({ ok: false, category, code });
}

function cloneJsonObject(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const cloned = cloneJsonValue(input);
  if (!isPlainObject(cloned)) throw new Error('Config root must be an object.');
  return cloned;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Config number must be finite.');
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(cloned, key, {
        value: cloneJsonValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  }
  throw new Error('Config value must be JSON-compatible.');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function appendPointer(path: string, segment: string): string {
  return `${path}/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function boundField(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_DIAGNOSTIC_FIELD_LENGTH) return value;
  return `${codePoints.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH - 3).join('')}...`;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isReferenceFailure(value: unknown): value is ConfigReferenceFailure {
  return isPlainObject(value)
    && (value['category'] === 'config_invalid' || value['category'] === 'secret_unavailable')
    && typeof value['code'] === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}