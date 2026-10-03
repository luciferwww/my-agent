import type { LogLevel } from './types.js';

export interface LoggerAdapterConfig {
  readonly enabled?: boolean;
  readonly minLevel?: LogLevel;
}

export interface LoggerConfig {
  readonly minLevel?: LogLevel;
  readonly console?: LoggerAdapterConfig;
  readonly file?: LoggerAdapterConfig;
}

type CompleteLoggerDefaults = LoggerConfig & {
  readonly minLevel: LogLevel;
  readonly console: LoggerAdapterConfig & { readonly enabled: boolean };
  readonly file: LoggerAdapterConfig & { readonly enabled: boolean };
};

export const DEFAULT_LOGGER_CONFIG: Readonly<CompleteLoggerDefaults> = deepFreeze({
  minLevel: 'info',
  console: { enabled: true },
  file: { enabled: false },
});

export class LoggerConfigValidationError extends Error {
  constructor(readonly fieldPath?: string) {
    super('Logger configuration is invalid.');
    this.name = 'LoggerConfigValidationError';
  }
}

export function validateLoggerConfig(value: unknown): asserts value is Partial<LoggerConfig> {
  if (!isObject(value)) throw new LoggerConfigValidationError();
  rejectUnknownFields(value, ['minLevel', 'console', 'file']);
  validateLevel(value['minLevel'], 'minLevel');
  validateAdapter(value['console'], 'console');
  validateAdapter(value['file'], 'file');
}

function validateAdapter(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isObject(value)) throw new LoggerConfigValidationError(path);
  rejectUnknownFields(value, ['enabled', 'minLevel'], path);
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    throw new LoggerConfigValidationError(`${path}.enabled`);
  }
  validateLevel(value['minLevel'], `${path}.minLevel`);
}

function validateLevel(value: unknown, path: string): void {
  if (value !== undefined && value !== 'debug' && value !== 'info' && value !== 'warn' && value !== 'error') {
    throw new LoggerConfigValidationError(path);
  }
}

function rejectUnknownFields(
  value: object,
  allowed: readonly string[],
  parent?: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new LoggerConfigValidationError(parent === undefined ? field : `${parent}.${field}`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
