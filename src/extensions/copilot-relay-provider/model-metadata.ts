import type { RelayModelBinding, RelayModelMetadata } from './types.js';

const CORE_IMAGE_MEDIA_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function parseRelayModelCatalog(payload: unknown): ReadonlyMap<string, RelayModelBinding> {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) {
    throw new Error('Copilot Relay model discovery response must contain a data array.');
  }

  const models = new Map<string, RelayModelBinding>();
  for (const raw of root.data) {
    const binding = parseModel(raw);
    if (!binding) continue;
    if (models.has(binding.metadata.id)) {
      throw new Error(`Copilot Relay returned duplicate model id "${binding.metadata.id}".`);
    }
    models.set(binding.metadata.id, binding);
  }
  return models;
}

function parseModel(value: unknown): RelayModelBinding | undefined {
  const entry = asRecord(value);
  if (!entry) return undefined;
  const id = readTrimmedString(entry.id);
  if (!id) return undefined;
  if (!Array.isArray(entry.supported_endpoints)
    || !entry.supported_endpoints.includes('/responses')) return undefined;

  const capabilities = asRecord(entry.capabilities);
  const limits = asRecord(capabilities?.limits);
  const maximumOutputTokens = readPositiveInteger(limits?.max_output_tokens);
  const promptLimits = [
    readPositiveInteger(limits?.max_prompt_tokens),
    readPositiveInteger(limits?.max_context_window_tokens),
  ].filter((candidate): candidate is number => candidate !== undefined);
  if (maximumOutputTokens === undefined || promptLimits.length === 0) return undefined;

  const supports = asRecord(capabilities?.supports);
  const toolUse = readBoolean(supports?.tool_calls);
  const vision = readBoolean(supports?.vision);
  const mediaTypes = readStringArray(
    entry.supported_image_media_types
      ?? entry.supported_media_types
      ?? capabilities?.supported_image_media_types
      ?? capabilities?.supported_media_types,
  ).filter((mediaType) => CORE_IMAGE_MEDIA_TYPES.has(mediaType));
  const supportedImageMediaTypes = Object.freeze(mediaTypes);
  const metadata: RelayModelMetadata = Object.freeze({
    id,
    ...(readTrimmedString(entry.name) ? { displayName: readTrimmedString(entry.name) } : {}),
    ...(readTrimmedString(entry.vendor) ? { vendor: readTrimmedString(entry.vendor) } : {}),
    ...(readTrimmedString(entry.version) ? { version: readTrimmedString(entry.version) } : {}),
    maximumPromptTokens: Math.min(...promptLimits),
    maximumOutputTokens,
    ...(toolUse === undefined ? {} : { toolUse }),
    ...(vision === undefined ? {} : { vision }),
    supportedImageMediaTypes,
  });

  return Object.freeze({
    metadata,
    facts: Object.freeze({
      effectiveContextLimit: Object.freeze({
        value: metadata.maximumPromptTokens,
        source: 'provider-metadata' as const,
      }),
      maximumOutputTokens: Object.freeze({
        value: metadata.maximumOutputTokens,
        source: 'provider-metadata' as const,
      }),
      ...(toolUse === undefined
        ? {}
        : { toolUse: Object.freeze({ value: toolUse, source: 'provider-metadata' as const }) }),
      ...(vision === true && supportedImageMediaTypes.length > 0
        ? {
            mediaKinds: Object.freeze({
              value: Object.freeze(['image']),
              source: 'provider-metadata' as const,
            }),
          }
        : {}),
    }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))];
}
