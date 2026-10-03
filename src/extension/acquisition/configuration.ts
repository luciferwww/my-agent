import { Ajv, type ValidateFunction } from 'ajv/dist/ajv.js';

import type {
  ExtensionLoaderDiagnosticCategory,
  ExtensionLoaderDiagnosticCode,
} from './types.js';
import {
  CredentialMaterializationError,
  materializeExactStringCredential,
} from '../../platform/config/credential-materialization.js';

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
        | 'environment_secret_unavailable'
        | 'config_schema_invalid'
        | 'config_validation_failed'
      >;
      referencePath?: string;
      environmentVariable?: string;
    }>;

interface ApiKeyMaterializationFailure {
  readonly category: Extract<ExtensionLoaderDiagnosticCategory, 'config_invalid' | 'secret_unavailable'>;
  readonly code: Extract<ExtensionLoaderDiagnosticCode, 'environment_secret_unavailable'>;
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

  const apiKeyFailure = materializeApiKey(config, environment);
  if (apiKeyFailure !== undefined) return Object.freeze({ ok: false, ...apiKeyFailure });

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

function materializeApiKey(
  config: Record<string, unknown>,
  environment: Readonly<Record<string, string | undefined>>,
): ApiKeyMaterializationFailure | Readonly<{
  category: 'config_invalid';
  code: 'config_validation_failed';
  referencePath: string;
}> | undefined {
  if (typeof config['apiKey'] !== 'string') return undefined;
  try {
    const apiKey = materializeExactStringCredential(config['apiKey'], environment);
    if (apiKey === undefined) delete config['apiKey'];
    else config['apiKey'] = apiKey;
    return undefined;
  } catch (error) {
    if (
      error instanceof CredentialMaterializationError
      && error.secretUnavailable
      && error.environmentVariable !== undefined
    ) {
      return Object.freeze({
        category: 'secret_unavailable',
        code: 'environment_secret_unavailable',
        referencePath: '/apiKey',
        environmentVariable: boundField(error.environmentVariable),
      });
    }
    return {
      category: 'config_invalid',
      code: 'config_validation_failed',
      referencePath: '/apiKey',
    };
  }
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

function boundField(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_DIAGNOSTIC_FIELD_LENGTH) return value;
  return `${codePoints.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH - 3).join('')}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}