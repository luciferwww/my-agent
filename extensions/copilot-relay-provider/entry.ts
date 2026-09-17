import type { ExtensionLoadContext, LoadedRuntimeUnit } from 'my-agent/extension-api';
import {
  DEFAULT_COPILOT_RELAY_BASE_URL,
  DEFAULT_COPILOT_RELAY_DISCOVERY_TIMEOUT_MS,
  createCopilotRelayProviderUnit,
  normalizeCopilotRelayBaseURL,
} from './copilot-relay-provider-unit.js';

export function createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit {
  const baseURL = readOptionalString(context.config, 'baseURL')
    ?? DEFAULT_COPILOT_RELAY_BASE_URL;
  const apiKey = readOptionalString(context.config, 'apiKey');
  const discoveryTimeoutMs = readOptionalPositiveSafeInteger(
    context.config,
    'discoveryTimeoutMs',
  ) ?? DEFAULT_COPILOT_RELAY_DISCOVERY_TIMEOUT_MS;

  return createCopilotRelayProviderUnit({
    baseURL: normalizeCopilotRelayBaseURL(baseURL),
    ...(apiKey === undefined ? {} : { apiKey }),
    discoveryTimeoutMs,
  });
}

function readOptionalString(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Copilot Relay ${key} must be a string.`);
  return value;
}

function readOptionalPositiveSafeInteger(
  config: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Copilot Relay ${key} must be a positive safe integer.`);
  }
  return value as number;
}
