import type {
  ExplicitThinkingEffort,
} from 'my-agent/extension-api';
import type {
  RelayModelBinding,
  RelayModelMetadata,
  RelayWireProtocol,
} from './types.js';

const CORE_IMAGE_MEDIA_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const KNOWN_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export interface RelayDiscoveryDiagnostic {
  readonly code: 'unknown_reasoning_effort';
  readonly ignoredValueCount: number;
}

export function parseRelayModelCatalog(
  payload: unknown,
  onDiagnostic?: (diagnostic: RelayDiscoveryDiagnostic) => void,
): ReadonlyMap<string, RelayModelBinding> {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) {
    throw new Error('Copilot Relay model discovery response must contain a data array.');
  }

  const models = new Map<string, RelayModelBinding>();
  for (const raw of root.data) {
    const binding = parseModel(raw, onDiagnostic);
    if (!binding) continue;
    if (models.has(binding.metadata.id)) {
      throw new Error(`Copilot Relay returned duplicate model id "${binding.metadata.id}".`);
    }
    models.set(binding.metadata.id, binding);
  }
  return models;
}

function parseModel(
  value: unknown,
  onDiagnostic: ((diagnostic: RelayDiscoveryDiagnostic) => void) | undefined,
): RelayModelBinding | undefined {
  const entry = asRecord(value);
  if (!entry) return undefined;
  const id = readOpaqueModelId(entry.id);
  if (id === undefined) return undefined;
  if (!Array.isArray(entry.supported_endpoints)) return undefined;
  const protocol: RelayWireProtocol | undefined =
    entry.supported_endpoints.includes('/responses')
      ? 'openai-responses'
      : entry.supported_endpoints.includes('/chat/completions')
        ? 'openai-chat-completions'
        : undefined;
  if (!protocol) return undefined;

  const capabilities = asRecord(entry.capabilities);
  const limits = asRecord(capabilities?.limits);
  const maximumOutputTokens = readPositiveInteger(limits?.max_output_tokens);
  const maximumContextTokens = readPositiveInteger(limits?.max_context_window_tokens);
  const declaredMaximumPromptTokens = readPositiveInteger(limits?.max_prompt_tokens);
  const promptLimits = [
    declaredMaximumPromptTokens,
    maximumContextTokens,
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
  const reasoning = parseReasoningCapabilities(
    supports,
    onDiagnostic,
  );
  const metadata: RelayModelMetadata = Object.freeze({
    id,
    ...(readTrimmedString(entry.name) ? { displayName: readTrimmedString(entry.name) } : {}),
    ...(readTrimmedString(entry.vendor) ? { vendor: readTrimmedString(entry.vendor) } : {}),
    ...(readTrimmedString(entry.version) ? { version: readTrimmedString(entry.version) } : {}),
    effectiveContextLimit: Math.min(...promptLimits),
    ...(maximumContextTokens === undefined ? {} : { maximumContextTokens }),
    ...(declaredMaximumPromptTokens === undefined
      ? {}
      : { maximumPromptTokens: declaredMaximumPromptTokens }),
    maximumOutputTokens,
    ...(toolUse === undefined ? {} : { toolUse }),
    ...(vision === undefined ? {} : { vision }),
    supportedImageMediaTypes,
    ...(reasoning === undefined ? {} : { reasoning }),
  });

  return Object.freeze({
    metadata,
    protocol,
    facts: Object.freeze({
      effectiveContextLimit: metadata.effectiveContextLimit,
      ...(metadata.maximumContextTokens === undefined
        ? {}
        : { maximumContextTokens: metadata.maximumContextTokens }),
      ...(metadata.maximumPromptTokens === undefined
        ? {}
        : { maximumPromptTokens: metadata.maximumPromptTokens }),
      maximumOutputTokens: metadata.maximumOutputTokens,
      ...(toolUse === undefined
        ? {}
        : { toolUse }),
      ...(vision === undefined
        ? {}
        : { mediaKinds: Object.freeze(vision ? ['image'] : []) }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }),
  });
}

function parseReasoningCapabilities(
  supports: Record<string, unknown> | undefined,
  onDiagnostic: ((diagnostic: RelayDiscoveryDiagnostic) => void) | undefined,
): RelayModelMetadata['reasoning'] {
  if (!supports || !Object.hasOwn(supports, 'reasoning_effort')) return undefined;
  const raw = supports.reasoning_effort;
  if (!Array.isArray(raw)) {
    throw new Error('Copilot Relay reasoning_effort must be an array.');
  }
  const efforts: ExplicitThinkingEffort[] = [];
  let unknownCount = 0;
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `Copilot Relay reasoning_effort[${index}] must be a non-empty string.`,
      );
    }
    if (!KNOWN_REASONING_EFFORTS.has(value)) {
      unknownCount += 1;
      continue;
    }
    const effort = value as ExplicitThinkingEffort;
    if (efforts.includes(effort)) {
      throw new Error(
        `Copilot Relay reasoning_effort[${index}] duplicates "${effort}".`,
      );
    }
    efforts.push(effort);
  }
  if (unknownCount > 0) {
    onDiagnostic?.({
      code: 'unknown_reasoning_effort',
      ignoredValueCount: unknownCount,
    });
  }
  if (efforts.length === 0) return undefined;
  return Object.freeze({
    efforts: Object.freeze(efforts),
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

function readOpaqueModelId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
