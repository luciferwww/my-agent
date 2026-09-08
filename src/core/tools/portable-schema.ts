import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv/dist/ajv.js';

export type PortableToolSchema = Readonly<Record<string, unknown>>;

export interface ToolInputValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ToolInputValidationError[];
}

export interface ToolInputValidationError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface CompiledToolInputValidator {
  readonly schema: PortableToolSchema;
  validate(input: Record<string, unknown>): ToolInputValidationResult;
}

export class PortableToolSchemaError extends Error {
  readonly kind = 'portable_tool_schema_error' as const;
}

const COMMON_KEYWORDS = new Set(['type', 'description', 'enum', 'const']);
const KEYWORDS_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  object: new Set(['properties', 'required', 'additionalProperties']),
  array: new Set(['items', 'minItems', 'maxItems', 'uniqueItems']),
  string: new Set(['minLength', 'maxLength', 'pattern']),
  number: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']),
  integer: new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']),
  boolean: new Set(),
  null: new Set(),
};

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});

export function compilePortableToolSchema(
  inputSchema: Record<string, unknown>,
): CompiledToolInputValidator {
  const cloned = cloneJsonObject(inputSchema);
  assertPortableSchema(cloned, '$', true);

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(cloned);
  } catch (error) {
    throw new PortableToolSchemaError(
      `Invalid portable Tool schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const schema = deepFreeze(cloned);
  return Object.freeze({
    schema,
    validate(input: Record<string, unknown>): ToolInputValidationResult {
      const valid = validate(input) === true;
      return Object.freeze({
        valid,
        errors: valid ? Object.freeze([]) : normalizeErrors(validate.errors),
      });
    },
  });
}

function assertPortableSchema(
  schema: Record<string, unknown>,
  path: string,
  root: boolean,
): void {
  const type = schema.type;
  if (typeof type !== 'string' || !(type in KEYWORDS_BY_TYPE)) {
    throw new PortableToolSchemaError(`${path}.type must be one portable JSON Schema type.`);
  }
  if (root && type !== 'object') {
    throw new PortableToolSchemaError('Tool input schema root type must be object.');
  }

  const allowedForType = KEYWORDS_BY_TYPE[type]!;
  for (const keyword of Object.keys(schema)) {
    if (!COMMON_KEYWORDS.has(keyword) && !allowedForType.has(keyword)) {
      throw new PortableToolSchemaError(`${path} uses unsupported keyword "${keyword}".`);
    }
  }

  if (type === 'object') {
    assertObjectKeywords(schema, path);
  } else if (type === 'array' && schema.items !== undefined) {
    assertSchemaObject(schema.items, `${path}.items`);
  }
}

function assertObjectKeywords(schema: Record<string, unknown>, path: string): void {
  const properties = schema.properties;
  if (properties !== undefined) {
    if (!isPlainObject(properties)) {
      throw new PortableToolSchemaError(`${path}.properties must be an object.`);
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      assertSchemaObject(propertySchema, `${path}.properties.${name}`);
    }
  }

  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
      throw new PortableToolSchemaError(`${path}.required must be an array of property names.`);
    }
    const names = required as string[];
    if (new Set(names).size !== names.length) {
      throw new PortableToolSchemaError(`${path}.required must not contain duplicates.`);
    }
    for (const name of names) {
      if (!isPlainObject(properties) || !(name in properties)) {
        throw new PortableToolSchemaError(`${path}.required contains undefined property "${name}".`);
      }
    }
  }

  const additional = schema.additionalProperties;
  if (additional !== undefined && typeof additional !== 'boolean') {
    assertSchemaObject(additional, `${path}.additionalProperties`);
  }
}

function assertSchemaObject(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new PortableToolSchemaError(`${path} must be a schema object.`);
  }
  assertPortableSchema(value, path, false);
}

function cloneJsonObject(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const cloned = structuredClone(input) as unknown;
    if (!isPlainObject(cloned)) throw new Error('schema must be an object');
    assertJsonValue(cloned, '$');
    return cloned;
  } catch (error) {
    throw new PortableToolSchemaError(
      `Tool input schema must be serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains a non-JSON value`);
}

function normalizeErrors(
  errors: ErrorObject[] | null | undefined,
): readonly ToolInputValidationError[] {
  return Object.freeze((errors ?? []).map((error) => Object.freeze({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'validation failed',
  })));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
