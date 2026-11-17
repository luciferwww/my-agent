import { Ajv, type ValidateFunction } from 'ajv/dist/ajv.js';

import type {
  ExtensionLoaderDiagnosticCategory,
  ExtensionLoaderDiagnosticCode,
} from './types.js';
import {
  CredentialMaterializationError,
  materializeExactStringCredential,
  parseCredentialEnvironmentReference,
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

interface SensitiveMaterializationFailure {
  readonly category: Extract<ExtensionLoaderDiagnosticCategory, 'config_invalid' | 'secret_unavailable'>;
  readonly code: Extract<ExtensionLoaderDiagnosticCode, 'environment_secret_unavailable'>;
  readonly referencePath: string;
  readonly environmentVariable: string;
}

export function prepareExtensionConfig(
  input: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
  mode: 'runtime' | 'save' = 'runtime',
): ExtensionConfigPreparationResult {
  let config: Record<string, unknown>;
  try {
    config = cloneJsonObject(input);
  } catch {
    return configFailure('config_invalid', 'config_validation_failed');
  }

  const sensitiveFailure = mode === 'runtime'
    ? materializeSensitiveStrings(config, schema, environment)
    : undefined;
  if (sensitiveFailure !== undefined) {
    return Object.freeze({ ok: false, ...sensitiveFailure });
  }

  let validate: ValidateFunction;
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    useDefaults: true,
    coerceTypes: false,
    removeAdditional: false,
  });
  try {
    validate = ajv.compile(cloneJsonObject(schema));
  } catch {
    return configFailure('config_invalid', 'config_schema_invalid');
  }
  if (mode === 'save') {
    // Apply Schema defaults before checking raw environment references.
    validate(config);
    const syntaxSchema = cloneJsonObject(schema);
    const properties = syntaxSchema['properties'];
    let changed = false;
    if (isPlainObject(properties)) {
      for (const [name, propertySchema] of Object.entries(properties)) {
        if (!isSensitiveRootString(propertySchema)) continue;
        try {
          if (parseCredentialEnvironmentReference(Object.hasOwn(config, name) ? config[name] : undefined) !== undefined) {
            Object.defineProperty(properties, name, {
              value: { type: 'string', writeOnly: true }, enumerable: true, configurable: true, writable: true,
            });
            changed = true;
          }
        } catch (error) {
          if (!(error instanceof CredentialMaterializationError)) throw error;
          return Object.freeze({
            ok: false,
            category: 'config_invalid',
            code: 'config_validation_failed',
            referencePath: boundedPropertyReferencePath(name),
          });
        }
      }
    }
    if (changed) {
      ajv.removeSchema();
      validate = ajv.compile(syntaxSchema);
    }
  }

  if (validate(config) !== true) {
    return configFailure('config_invalid', 'config_validation_failed');
  }

  return Object.freeze({
    ok: true,
    config: deepFreeze(config),
  });
}

export function extensionSettingsFields(schema: Readonly<Record<string, unknown>>) {
  const properties = schema['properties'];
  if (!isPlainObject(properties)) return [];
  return Object.entries(properties).map(([name, value]) => {
    const supported = isPlainObject(value)
      && !hasReferenceOrComposition(value)
      && ['string', 'integer', 'number', 'boolean'].includes(String(value['type']));
    const sensitive = isPlainObject(value) && value['writeOnly'] === true;
    return {
      name,
      path: `/${escapeJsonPointerSegment(name)}`,
      supported,
      editable: supported && value['readOnly'] !== true && (!sensitive || isSensitiveRootString(value)),
      sensitive,
      schema: supported && (!sensitive || isSensitiveRootString(value))
        ? Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive || key !== 'default'))
        : undefined,
    };
  });
}

function materializeSensitiveStrings(
  config: Record<string, unknown>,
  schema: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
): SensitiveMaterializationFailure | Readonly<{
  category: 'config_invalid';
  code: 'config_validation_failed';
  referencePath: string;
}> | undefined {
  const properties = schema['properties'];
  if (!isPlainObject(properties)) return undefined;

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (!isSensitiveRootString(propertySchema) || typeof config[propertyName] !== 'string') {
      continue;
    }
    const referencePath = boundedPropertyReferencePath(propertyName);
    try {
      const materialized = materializeExactStringCredential(
        config[propertyName],
        environment,
      );
      if (materialized === undefined) delete config[propertyName];
      else config[propertyName] = materialized;
    } catch (error) {
      if (
        error instanceof CredentialMaterializationError
        && error.secretUnavailable
        && error.environmentVariable !== undefined
      ) {
        return Object.freeze({
          category: 'secret_unavailable',
          code: 'environment_secret_unavailable',
          referencePath,
          environmentVariable: boundField(error.environmentVariable),
        });
      }
      return {
        category: 'config_invalid',
        code: 'config_validation_failed',
        referencePath,
      };
    }
  }
  return undefined;
}

function isSensitiveRootString(value: unknown): boolean {
  return isPlainObject(value)
    && value['type'] === 'string'
    && value['writeOnly'] === true
    && !hasReferenceOrComposition(value);
}

function hasReferenceOrComposition(value: Readonly<Record<string, unknown>>): boolean {
  return [
    '$ref',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
  ].some((keyword) => keyword in value);
}

function boundedPropertyReferencePath(propertyName: string): string {
  const fullPath = `/${escapeJsonPointerSegment(propertyName)}`;
  if (fullPath.length <= MAX_DIAGNOSTIC_FIELD_LENGTH) return fullPath;

  const suffix = '...';
  let escapedPreview = '';
  for (const codePoint of propertyName) {
    const escapedCodePoint = escapeJsonPointerSegment(codePoint);
    if (
      1 + escapedPreview.length + escapedCodePoint.length + suffix.length
      > MAX_DIAGNOSTIC_FIELD_LENGTH
    ) {
      break;
    }
    escapedPreview += escapedCodePoint;
  }
  return `/${escapedPreview}${suffix}`;
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
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