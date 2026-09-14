import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ExtensionAcquisitionFatalError } from './errors.js';
import type { ResolvedHostExtensionsConfig } from './types.js';

const EMPTY_ENTRIES = Object.freeze({}) as Readonly<Record<string, unknown>>;
const EMPTY_EXTENSIONS_CONFIG: ResolvedHostExtensionsConfig = Object.freeze({
  enabled: true,
  entries: EMPTY_ENTRIES,
});

export async function readHostExtensionsConfig(
  agentHome: string,
): Promise<ResolvedHostExtensionsConfig> {
  const configPath = join(agentHome, 'config.json');
  try {
    await lstat(configPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return EMPTY_EXTENSIONS_CONFIG;
    throw invalidHostConfig('Host configuration file could not be inspected.');
  }

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw invalidHostConfig('Host configuration file could not be read.');
  }

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    throw invalidHostConfig('Host configuration file contains invalid JSON.');
  }

  if (!isPlainObject(root)) {
    throw invalidHostConfig('Host configuration root must be an object.');
  }

  const extensions = root['extensions'];
  if (extensions === undefined) return EMPTY_EXTENSIONS_CONFIG;
  if (!isPlainObject(extensions)) {
    throw invalidHostConfig('Host configuration extensions namespace must be an object.');
  }

  const enabled = extensions['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw invalidHostConfig('Host configuration extensions.enabled must be a boolean.');
  }

  const entries = extensions['entries'];
  if (entries !== undefined && !isPlainObject(entries)) {
    throw invalidHostConfig('Host configuration extensions.entries must be an object.');
  }

  const frozenEntries = entries === undefined
    ? EMPTY_ENTRIES
    : freezeJsonObject(entries);
  return Object.freeze({
    enabled: enabled ?? true,
    entries: frozenEntries,
  });
}

function invalidHostConfig(message: string): ExtensionAcquisitionFatalError {
  return new ExtensionAcquisitionFatalError('HOST_CONFIG_INVALID', message);
}

function freezeJsonObject(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  for (const child of Object.values(value)) freezeJsonValue(child);
  return Object.freeze(value);
}

function freezeJsonValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) freezeJsonValue(child);
    Object.freeze(value);
    return;
  }
  if (isPlainObject(value)) freezeJsonObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}
