import type { ExtensionRegistrationApi } from '../../core/registry/index.js';
import type { LoadedRuntimeUnit } from '../../runtime/runtime-unit.js';
import { CopilotRelayProvider } from './copilot-relay-provider.js';
import { parseRelayModelCatalog } from './model-metadata.js';
import { CopilotRelayResponsesClient } from './responses-client.js';
import type { CopilotRelayProviderUnitOptions } from './types.js';

export const COPILOT_RELAY_PROVIDER_UNIT_ID = 'copilot-relay-provider';
export const DEFAULT_COPILOT_RELAY_BASE_URL = 'http://127.0.0.1:5000';
export const DEFAULT_COPILOT_RELAY_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;

export function createCopilotRelayProviderUnit(
  options: CopilotRelayProviderUnitOptions,
): LoadedRuntimeUnit {
  const captured = captureOptions(options);
  return Object.freeze({
    unitId: COPILOT_RELAY_PROVIDER_UNIT_ID,
    source: 'external' as const,
    orderKey: COPILOT_RELAY_PROVIDER_UNIT_ID,
    required: false,
    initiallyEnabled: true,
    dependencies: Object.freeze([]),
    async create(signal: AbortSignal) {
      const baseURL = normalizeCopilotRelayBaseURL(
        captured.baseURL ?? DEFAULT_COPILOT_RELAY_BASE_URL,
      );
      const models = await discoverModels(baseURL, captured, signal);
      const client = new CopilotRelayResponsesClient({
        baseURL,
        apiKey: captured.apiKey,
        fetch: captured.fetch,
      });
      const provider = new CopilotRelayProvider(baseURL, client, models);
      return Object.freeze({
        registration: Object.freeze({
          id: COPILOT_RELAY_PROVIDER_UNIT_ID,
          source: 'external' as const,
          register(api: ExtensionRegistrationApi) {
            api.registerProvider(provider.entry);
          },
        }),
        start() {},
        stop() {},
      });
    },
  });
}

export function normalizeCopilotRelayBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Copilot Relay baseURL must be a valid loopback HTTP URL.');
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (
    !loopback
    || (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Copilot Relay baseURL must be a credential-free loopback HTTP URL without query or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function captureOptions(
  options: CopilotRelayProviderUnitOptions,
): CopilotRelayProviderUnitOptions {
  const discoveryTimeoutMs = options.discoveryTimeoutMs
    ?? DEFAULT_COPILOT_RELAY_DISCOVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(discoveryTimeoutMs) || discoveryTimeoutMs < 1) {
    throw new Error('Copilot Relay discoveryTimeoutMs must be a positive safe integer.');
  }
  return Object.freeze({
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    discoveryTimeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

async function discoverModels(
  baseURL: string,
  options: CopilotRelayProviderUnitOptions,
  parentSignal: AbortSignal,
) {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Copilot Relay model discovery timed out.', 'TimeoutError'));
  }, options.discoveryTimeoutMs);
  timeout.unref?.();
  try {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    const apiKey = options.apiKey?.trim();
    const response = await (options.fetch ?? globalThis.fetch)(`${baseURL}/v1/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Copilot Relay model discovery failed with HTTP ${response.status}.`);
    }
    const text = await readBoundedBody(response, MAX_DISCOVERY_BYTES, controller.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Copilot Relay model discovery returned invalid JSON.');
    }
    return parseRelayModelCatalog(payload);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw new Error('Copilot Relay model discovery response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await readWithSignal(reader, signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        throw new Error('Copilot Relay model discovery response exceeded its size limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(abortReason(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortReason(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}
