import type { ExtensionDescriptorV1 } from '../../../extension/acquisition/index.js';
import type { InitializationPrompter, PromptOption } from './prompts.js';

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const COMPOSITION_KEYS = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

export class UnsupportedInitializationSchemaError extends Error {
  constructor(readonly propertyName: string) {
    super(`Unsupported configuration field: ${propertyName}.`);
    this.name = 'UnsupportedInitializationSchemaError';
  }
}

export async function collectExtensionConfiguration(
  descriptor: ExtensionDescriptorV1,
  prompter: InitializationPrompter,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>> {
  const properties = asRecord(descriptor.configSchema['properties']) ?? {};
  const required = new Set(
    Array.isArray(descriptor.configSchema['required'])
      ? descriptor.configSchema['required'].filter((value): value is string =>
          typeof value === 'string')
      : [],
  );
  const config: Record<string, unknown> = {};

  for (const [propertyName, value] of Object.entries(properties)) {
    const schema = asRecord(value);
    const isRequired = required.has(propertyName);
    if (!schema || !isSupportedShape(schema)) {
      if (isRequired && !hasDefault(schema)) {
        throw new UnsupportedInitializationSchemaError(propertyName);
      }
      continue;
    }

    const label = typeof schema['title'] === 'string' && schema['title'].trim()
      ? schema['title']
      : propertyName;
    const description = typeof schema['description'] === 'string' && schema['description'].trim()
      ? schema['description']
      : undefined;
    const message = description ? `${label} — ${description}` : label;
    const defaultValue = schema['default'];
    const enumValues = supportedEnum(schema['enum']);

    let authored: unknown;
    if (enumValues) {
      authored = await promptEnum(
        prompter,
        message,
        enumValues,
        isRequired,
        defaultValue,
      );
    } else if (schema['type'] === 'string' && schema['writeOnly'] === true) {
      authored = await promptSensitiveString(
        prompter,
        message,
        isRequired,
        environment,
      );
    } else if (schema['type'] === 'string') {
      authored = await promptString(prompter, message, schema, isRequired);
    } else if (schema['type'] === 'integer' || schema['type'] === 'number') {
      authored = await promptNumber(prompter, message, schema, isRequired);
    } else if (schema['type'] === 'boolean') {
      authored = await promptBoolean(prompter, message, isRequired, defaultValue);
    }

    if (authored !== undefined && !Object.is(authored, defaultValue)) {
      config[propertyName] = authored;
    }
  }

  return config;
}

function isSupportedShape(schema: Record<string, unknown>): boolean {
  if ([...COMPOSITION_KEYS].some((key) => key in schema)) return false;
  const enumValues = supportedEnum(schema['enum']);
  if (enumValues) return true;
  return schema['type'] === 'string'
    || schema['type'] === 'integer'
    || schema['type'] === 'number'
    || schema['type'] === 'boolean';
}

async function promptEnum(
  prompter: InitializationPrompter,
  message: string,
  values: readonly (string | number | boolean)[],
  required: boolean,
  defaultValue: unknown,
): Promise<unknown> {
  const options: PromptOption[] = values.map((value, index) => ({
    value: `value:${index}`,
    label: String(value),
  }));
  if (!required && defaultValue === undefined) {
    options.unshift({ value: 'unset', label: 'Leave unset' });
  }
  const defaultIndex = values.findIndex((value) => Object.is(value, defaultValue));
  const selected = await prompter.select(
    message,
    options,
    defaultIndex < 0 ? options[0]?.value : `value:${defaultIndex}`,
  );
  if (selected === 'unset') return undefined;
  return values[Number(selected.slice('value:'.length))];
}

async function promptSensitiveString(
  prompter: InitializationPrompter,
  label: string,
  required: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const options: PromptOption[] = [
    { value: 'literal', label: 'Enter now' },
    { value: 'environment', label: 'Use an environment variable' },
  ];
  if (!required) options.push({ value: 'none', label: 'No credential' });
  const source = await prompter.select(`How should ${label} be supplied?`, options, 'literal');
  if (source === 'none') return undefined;
  if (source === 'literal') {
    return prompter.text({
      message: `Enter ${label}`,
      masked: true,
      validate: (value) => value.trim() ? undefined : `${label} is required.`,
    });
  }
  const name = await prompter.text({
    message: 'Enter the environment variable name',
    validate: (value) => {
      if (!ENVIRONMENT_NAME.test(value)) {
        return 'Use an environment variable name matching [A-Z_][A-Z0-9_]*.';
      }
      if (!environment[value]?.trim()) {
        return `Environment variable ${value} is not set or is blank.`;
      }
      return undefined;
    },
  });
  return `\${${name}}`;
}

async function promptString(
  prompter: InitializationPrompter,
  message: string,
  schema: Record<string, unknown>,
  required: boolean,
): Promise<string | undefined> {
  const defaultValue = typeof schema['default'] === 'string' ? schema['default'] : undefined;
  const value = await prompter.text({
    message,
    ...(defaultValue === undefined ? {} : { placeholder: defaultValue }),
    validate: (candidate) => validateString(candidate, schema, required, defaultValue !== undefined),
  });
  return value === '' ? undefined : value;
}

async function promptNumber(
  prompter: InitializationPrompter,
  message: string,
  schema: Record<string, unknown>,
  required: boolean,
): Promise<number | undefined> {
  const defaultValue = typeof schema['default'] === 'number'
    ? String(schema['default'])
    : undefined;
  const value = await prompter.text({
    message,
    ...(defaultValue === undefined ? {} : { placeholder: defaultValue }),
    validate: (candidate) => validateNumber(candidate, schema, required, defaultValue !== undefined),
  });
  return value === '' ? undefined : Number(value);
}

async function promptBoolean(
  prompter: InitializationPrompter,
  message: string,
  required: boolean,
  defaultValue: unknown,
): Promise<boolean | undefined> {
  if (!required && typeof defaultValue !== 'boolean') {
    const selected = await prompter.select(message, [
      { value: 'unset', label: 'Leave unset' },
      { value: 'true', label: 'true' },
      { value: 'false', label: 'false' },
    ], 'unset');
    return selected === 'unset' ? undefined : selected === 'true';
  }
  return prompter.confirm(
    message,
    typeof defaultValue === 'boolean' ? defaultValue : false,
  );
}

function validateString(
  value: string,
  schema: Record<string, unknown>,
  required: boolean,
  hasSchemaDefault: boolean,
): string | undefined {
  if (value === '') {
    return required && !hasSchemaDefault ? 'A value is required.' : undefined;
  }
  if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
    return `Enter at least ${schema['minLength']} characters.`;
  }
  if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
    return `Enter no more than ${schema['maxLength']} characters.`;
  }
  if (typeof schema['pattern'] === 'string') {
    try {
      if (!new RegExp(schema['pattern'], 'u').test(value)) {
        return 'The value does not match the required pattern.';
      }
    } catch {
      return 'The Extension configuration Schema is invalid.';
    }
  }
  return undefined;
}

function validateNumber(
  value: string,
  schema: Record<string, unknown>,
  required: boolean,
  hasSchemaDefault: boolean,
): string | undefined {
  if (value === '') {
    return required && !hasSchemaDefault ? 'A value is required.' : undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'Enter a finite number.';
  if (schema['type'] === 'integer' && !Number.isInteger(parsed)) {
    return 'Enter an integer.';
  }
  if (typeof schema['minimum'] === 'number' && parsed < schema['minimum']) {
    return `Enter a value greater than or equal to ${schema['minimum']}.`;
  }
  if (typeof schema['maximum'] === 'number' && parsed > schema['maximum']) {
    return `Enter a value less than or equal to ${schema['maximum']}.`;
  }
  return undefined;
}

function supportedEnum(value: unknown): readonly (string | number | boolean)[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((entry) =>
    typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
    ? value as readonly (string | number | boolean)[]
    : undefined;
}

function hasDefault(schema: Record<string, unknown> | undefined): boolean {
  return schema !== undefined && Object.prototype.hasOwnProperty.call(schema, 'default');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
