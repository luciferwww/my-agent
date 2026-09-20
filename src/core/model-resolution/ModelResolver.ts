import type {
  CanonicalModelIdentity,
  ModelResolutionInput,
  ProviderModelFacts,
  ProviderProjectionEntry,
  ResolvedModel,
  ResolutionFailureCategory,
} from './types.js';

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ModelResolutionError extends Error {
  constructor(
    readonly category: ResolutionFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

export class ModelResolver {
  private readonly providers: ReadonlyMap<string, ProviderProjectionEntry>;

  constructor(providers: readonly ProviderProjectionEntry[]) {
    const entries = new Map<string, ProviderProjectionEntry>();
    for (const provider of providers) {
      const id = validateProviderId(provider.id);
      if (!id || entries.has(id)) {
        throw new Error(`Provider projection contains an invalid or duplicate identity: ${provider.id}`);
      }
      entries.set(id, provider);
    }
    this.providers = entries;
  }

  resolve(input: ModelResolutionInput): ResolvedModel {
    const reference = this.normalizeReference(input.reference);
    const provider = this.providers.get(reference.providerId);
    if (!provider) {
      throw new ModelResolutionError(
        'provider_unregistered',
        `Provider is not registered: ${reference.providerId}`,
      );
    }

    if (!provider.models.some((model) => model.modelId === reference.modelId)) {
      throw new ModelResolutionError(
        'model_rejected',
        `Model is not in the Provider Catalog for Provider "${reference.providerId}".`,
      );
    }

    const connectionResult = provider.resolveConnection();
    if (!connectionResult.ok) {
      throw new ModelResolutionError(connectionResult.category, connectionResult.message);
    }

    const modelResult = provider.resolveModel(reference.modelId, connectionResult.connection);
    if (!modelResult.ok) {
      throw new ModelResolutionError(modelResult.category, modelResult.message);
    }

    const { descriptor } = modelResult;
    this.assertBindingConsistency(
      reference,
      provider,
      descriptor.identity.providerId,
      descriptor.identity.modelId,
      descriptor.protocol,
    );
    if (descriptor.connection.endpointId !== connectionResult.connection.endpointId) {
      throw new ModelResolutionError(
        'protocol_incompatible',
        'Provider model descriptor does not match the selected connection.',
      );
    }

    if (input.policy.allowModel && !input.policy.allowModel(descriptor.identity)) {
      throw new ModelResolutionError('policy_denied', 'Model policy denied the selected model.');
    }

    const facts = this.requireFacts(descriptor.facts);
    if (input.request.tools && facts.toolUse === false) {
      throw new ModelResolutionError(
        'capability_unsupported',
        'The selected model does not support Tool Use.',
      );
    }
    if (input.request.mediaKinds.length > 0) {
      const supported = facts.mediaKinds;
      if (supported
        && input.request.mediaKinds.some((kind) => !supported.includes(kind))) {
        throw new ModelResolutionError(
          'capability_unsupported',
          'The selected model does not support all requested media kinds.',
        );
      }
    }

    return Object.freeze({
      identity: Object.freeze({ ...descriptor.identity }),
      referenceSource: input.referenceSource ?? 'native',
      protocol: descriptor.protocol,
      endpointId: descriptor.connection.endpointId,
      ...(descriptor.connection.deploymentId
        ? { deploymentId: descriptor.connection.deploymentId }
        : {}),
      invocationPort: provider.invocationPort,
      facts: Object.freeze({
        effectiveContextLimit: facts.effectiveContextLimit,
        ...(facts.maximumOutputTokens !== undefined
          ? { maximumOutputTokens: facts.maximumOutputTokens }
          : {}),
        ...(facts.toolUse !== undefined ? { toolUse: facts.toolUse } : {}),
        ...(facts.mediaKinds
          ? { mediaKinds: Object.freeze([...facts.mediaKinds]) }
          : {}),
      }),
    });
  }

  private normalizeReference(
    reference: ModelResolutionInput['reference'],
  ): CanonicalModelIdentity {
    const providerId = normalizeProviderId(reference?.providerId);
    const modelId = reference?.modelId;
    if (!providerId || typeof modelId !== 'string') {
      throw new ModelResolutionError('reference_invalid', 'A valid Provider and Model reference is required.');
    }
    return { providerId, modelId };
  }

  private assertBindingConsistency(
    reference: CanonicalModelIdentity,
    provider: ProviderProjectionEntry,
    descriptorProviderId: string,
    descriptorModelId: string,
    descriptorProtocol: string,
  ): void {
    if (
      descriptorProviderId !== reference.providerId
      || descriptorModelId !== reference.modelId
      || descriptorProtocol !== provider.protocol
    ) {
      throw new ModelResolutionError(
        'protocol_incompatible',
        'Provider identity, protocol, facts, and invocation binding are inconsistent.',
      );
    }
  }

  private requireFacts(facts: ProviderModelFacts): {
    effectiveContextLimit: number;
    maximumOutputTokens?: number;
    toolUse?: boolean;
    mediaKinds?: readonly string[];
  } {
    if (
      !isPositiveInteger(facts.effectiveContextLimit)
      || (facts.maximumOutputTokens !== undefined && !isPositiveInteger(facts.maximumOutputTokens))
      || (facts.toolUse !== undefined && typeof facts.toolUse !== 'boolean')
      || (facts.mediaKinds !== undefined && !isMediaKinds(facts.mediaKinds))
    ) {
      throw new ModelResolutionError(
        'facts_insufficient',
        'Provider model facts are missing a valid effective Context limit.',
      );
    }
    return {
      effectiveContextLimit: facts.effectiveContextLimit,
      ...(facts.maximumOutputTokens !== undefined
        ? { maximumOutputTokens: facts.maximumOutputTokens }
        : {}),
      ...(facts.toolUse !== undefined ? { toolUse: facts.toolUse } : {}),
      ...(facts.mediaKinds ? { mediaKinds: facts.mediaKinds } : {}),
    };
  }
}

function normalizeProviderId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && PROVIDER_ID.test(normalized) ? normalized : undefined;
}

function validateProviderId(value: string | undefined): string | undefined {
  return value && PROVIDER_ID.test(value) ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isMediaKinds(value: readonly string[]): boolean {
  return (
    Array.isArray(value)
    && value.every((kind) => typeof kind === 'string' && kind.length > 0)
  );
}
