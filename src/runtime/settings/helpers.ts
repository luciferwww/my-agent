import type { SettingsActionRequest, SettingsActionResult } from '../../core/settings/index.js';
import { AgentConfigError, ConfigEditError } from '../../platform/config/index.js';
import { CredentialMaterializationError } from '../../platform/config/credential-materialization.js';
import { Logger } from '../../platform/logger/index.js';

const log = Logger.get('SettingsManager');

export class SettingsClosingError extends Error {}

export function settingsFailure(
  request: SettingsActionRequest, code: string, message: string, output?: unknown, fieldPath?: string,
): SettingsActionResult {
  return {
    requestId: request.requestId, action: request.action, ok: false,
    error: { code, message, ...(fieldPath === undefined ? {} : { fieldPath }) },
    ...(output === undefined ? {} : { output }),
  };
}

export function success(request: SettingsActionRequest, output: unknown): SettingsActionResult {
  return { requestId: request.requestId, action: request.action, ok: true, output };
}

export function closingFailure(request: SettingsActionRequest, output?: unknown): SettingsActionResult {
  return settingsFailure(request, 'runtime_closing', 'Runtime is closing; no new Settings updates or model Tests are admitted.', output);
}

export function errorCode(error: unknown): string {
  if (error instanceof AgentConfigError) return error.code;
  if (error instanceof ConfigEditError) return 'validation_failed';
  if (error instanceof CredentialMaterializationError) return 'invalid_credential';
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EBUSY'].includes(error.code)) {
    return error.code;
  }
  return 'unexpected_failure';
}

export function failure(request: SettingsActionRequest, error: unknown): SettingsActionResult {
  if (error instanceof SettingsClosingError) return closingFailure(request);
  if (error instanceof ConfigEditError || error instanceof AgentConfigError) {
    return settingsFailure(request, errorCode(error), error.message, undefined, error.fieldPath);
  }
  if (error instanceof CredentialMaterializationError) {
    return settingsFailure(request, 'invalid_credential', 'Invalid credential syntax.');
  }
  log.error('Settings operation failed', { action: request.action, code: errorCode(error) });
  return settingsFailure(request, 'settings_failed', 'The Settings operation failed.');
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function object(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isObject(value)) throw new ConfigEditError(fieldPath);
  return value;
}

export function onlyKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new ConfigEditError('/input');
}
