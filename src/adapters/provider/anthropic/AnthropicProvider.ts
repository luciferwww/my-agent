import type {
  ProviderConnection,
  ProviderModelFacts,
  ProviderProjectionEntry,
} from '../../../core/model-resolution/index.js';
import { AnthropicClient } from './AnthropicClient.js';

export const ANTHROPIC_COMPATIBLE_PROVIDER_ID = 'anthropic-compatible';
export const ANTHROPIC_MESSAGES_PROTOCOL = 'anthropic-messages';
const DEFAULT_ENDPOINT = 'https://api.anthropic.com';

export interface AnthropicDeploymentFactsInput {
  providerId: string;
  endpointId: string;
  modelId: string;
  deploymentId?: string;
  protocol: string;
  effectiveContextLimit?: number;
  maximumOutputTokens?: number;
  toolUse?: boolean;
  mediaKinds?: readonly string[];
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  deploymentFacts?: readonly AnthropicDeploymentFactsInput[];
}

interface CatalogFacts {
  effectiveContextLimit: number;
  maximumOutputTokens: number;
  toolUse: boolean;
  mediaKinds: readonly string[];
}

interface CatalogModelBinding {
  readonly modelId: string;
  readonly deploymentId?: string;
  readonly facts: ProviderModelFacts;
}

// Source reviewed 2026-09-04:
// https://platform.claude.com/docs/en/models/overview
const STATIC_CATALOG: ReadonlyMap<string, CatalogFacts> = new Map([
  ['claude-fable-5-1', {
    effectiveContextLimit: 1_000_000,
    maximumOutputTokens: 128_000,
    toolUse: true,
    mediaKinds: ['image'],
  }],
  ['claude-opus-5', {
    effectiveContextLimit: 1_000_000,
    maximumOutputTokens: 128_000,
    toolUse: true,
    mediaKinds: ['image'],
  }],
  ['claude-sonnet-5', {
    effectiveContextLimit: 1_000_000,
    maximumOutputTokens: 128_000,
    toolUse: true,
    mediaKinds: ['image'],
  }],
  ['claude-haiku-4-5-20251001', {
    effectiveContextLimit: 200_000,
    maximumOutputTokens: 64_000,
    toolUse: true,
    mediaKinds: ['image'],
  }],
]);

export class AnthropicProvider {
  readonly entry: ProviderProjectionEntry;

  constructor(options: AnthropicProviderOptions) {
    const endpointId = normalizeEndpoint(options.baseURL ?? DEFAULT_ENDPOINT);
    const deploymentFacts = validateDeploymentFacts(options.deploymentFacts ?? []);
    const modelMap = buildModelMap(endpointId, deploymentFacts);
    const invocationPort = new AnthropicClient({
      apiKey: options.apiKey ?? '',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });

    this.entry = Object.freeze({
      id: ANTHROPIC_COMPATIBLE_PROVIDER_ID,
      displayName: 'Anthropic Compatible',
      models: Object.freeze([...modelMap.values()].map((model) => Object.freeze({
        modelId: model.modelId,
      }))),
      protocol: ANTHROPIC_MESSAGES_PROTOCOL,
      invocationPort,
      resolveConnection: () => {
        if (!options.apiKey?.trim()) {
          return {
            ok: false,
            category: 'connection_missing',
            message: 'Anthropic-compatible Provider API key is missing.',
          } as const;
        }
        return {
          ok: true,
          connection: Object.freeze({ endpointId }),
        } as const;
      },
      resolveModel: (modelId: string, connection: ProviderConnection) => {
        const canonicalModelId = modelId.trim();
        const model = modelMap.get(canonicalModelId);
        if (!model) {
          return {
            ok: false,
            category: 'model_rejected',
            message: 'Anthropic-compatible Provider rejected a model outside its Catalog.',
          } as const;
        }
        return {
          ok: true,
          descriptor: Object.freeze({
            identity: Object.freeze({
              providerId: ANTHROPIC_COMPATIBLE_PROVIDER_ID,
              modelId: canonicalModelId,
            }),
            protocol: ANTHROPIC_MESSAGES_PROTOCOL,
            connection: Object.freeze({
              ...connection,
              ...(model.deploymentId ? { deploymentId: model.deploymentId } : {}),
            }),
            facts: model.facts,
          }),
        } as const;
      },
    });
  }
}

function resolveFacts(input: {
  deployment?: AnthropicDeploymentFactsInput;
  catalog?: CatalogFacts;
}): ProviderModelFacts {
  const { deployment, catalog } = input;
  return {
    effectiveContextLimit: deployment?.effectiveContextLimit !== undefined
      ? { value: deployment.effectiveContextLimit, source: 'deployment-config' }
      : catalog
        ? { value: catalog.effectiveContextLimit, source: 'static-provider-catalog' }
        : { value: 200_000, source: 'provider-default' },
    ...(deployment?.maximumOutputTokens !== undefined
      ? { maximumOutputTokens: { value: deployment.maximumOutputTokens, source: 'deployment-config' } }
      : catalog
        ? { maximumOutputTokens: { value: catalog.maximumOutputTokens, source: 'static-provider-catalog' } }
        : {}),
    ...(deployment?.toolUse !== undefined
      ? { toolUse: { value: deployment.toolUse, source: 'deployment-config' } }
      : catalog
        ? { toolUse: { value: catalog.toolUse, source: 'static-provider-catalog' } }
        : {}),
    ...(deployment?.mediaKinds !== undefined
      ? {
          mediaKinds: {
            value: Object.freeze([...deployment.mediaKinds]),
            source: 'deployment-config',
          },
        }
      : catalog
        ? {
            mediaKinds: {
              value: Object.freeze([...catalog.mediaKinds]),
              source: 'static-provider-catalog',
            },
          }
        : {}),
  };
}

function buildModelMap(
  endpointId: string,
  deploymentFacts: readonly AnthropicDeploymentFactsInput[],
): ReadonlyMap<string, CatalogModelBinding> {
  const candidates = new Map<string, {
    catalog?: CatalogFacts;
    deployment?: AnthropicDeploymentFactsInput;
  }>();
  if (endpointId === DEFAULT_ENDPOINT) {
    for (const [modelId, catalog] of STATIC_CATALOG) {
      candidates.set(modelId, { catalog });
    }
  }
  for (const deployment of deploymentFacts) {
    if (deployment.endpointId !== endpointId) continue;
    const candidate = candidates.get(deployment.modelId) ?? {};
    candidates.set(deployment.modelId, { ...candidate, deployment });
  }

  const models = new Map<string, CatalogModelBinding>();
  for (const [modelId, candidate] of candidates) {
    const facts = resolveFacts(candidate);
    if (!facts.maximumOutputTokens) continue;
    models.set(modelId, Object.freeze({
      modelId,
      ...(candidate.deployment?.deploymentId
        ? { deploymentId: candidate.deployment.deploymentId }
        : {}),
      facts: Object.freeze(facts),
    }));
  }
  return models;
}

function validateDeploymentFacts(
  entries: readonly AnthropicDeploymentFactsInput[],
): readonly AnthropicDeploymentFactsInput[] {
  const identities = new Set<string>();
  return Object.freeze(entries.map((entry) => {
    if (
      entry.providerId.trim() !== ANTHROPIC_COMPATIBLE_PROVIDER_ID
      || entry.protocol.trim() !== ANTHROPIC_MESSAGES_PROTOCOL
      || !entry.modelId.trim()
      || (entry.effectiveContextLimit !== undefined && !isPositiveInteger(entry.effectiveContextLimit))
      || (entry.maximumOutputTokens !== undefined && !isPositiveInteger(entry.maximumOutputTokens))
      || entry.mediaKinds?.some((kind) => !kind.trim())
    ) {
      throw new Error('Invalid Anthropic-compatible deployment-facts entry.');
    }
    const normalized = Object.freeze({
      ...entry,
      providerId: entry.providerId.trim(),
      protocol: entry.protocol.trim(),
      endpointId: normalizeEndpoint(entry.endpointId),
      modelId: entry.modelId.trim(),
      ...(entry.deploymentId ? { deploymentId: entry.deploymentId.trim() } : {}),
      ...(entry.mediaKinds ? { mediaKinds: Object.freeze(entry.mediaKinds.map((kind) => kind.trim())) } : {}),
    });
    const identity = `${normalized.providerId}\u0000${normalized.endpointId}\u0000${normalized.modelId}`;
    if (identities.has(identity)) {
      throw new Error('Duplicate Anthropic-compatible deployment-facts entry.');
    }
    identities.add(identity);
    return normalized;
  }));
}

function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Anthropic-compatible Provider endpoint is invalid.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Anthropic-compatible Provider endpoint is invalid or contains sensitive data.');
  }
  return url.toString().replace(/\/$/, '');
}

function isPositiveInteger(value: number | undefined): value is number {
  return Number.isInteger(value) && value! > 0;
}
