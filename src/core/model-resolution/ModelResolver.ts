import type {
  CanonicalModelIdentity,
  ModelResolutionInput,
  ProviderModelFacts,
  ProviderProjectionEntry,
  ResolvedModel,
  ResolutionFailureCategory,
  SourcedFact,
} from './types.js';

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
      const id = normalizeIdentityPart(provider.id);
      if (!id || entries.has(id)) {
        throw new Error(`Provider projection contains an invalid or duplicate identity: ${provider.id}`);
      }
      entries.set(id, provider);
    }
    this.providers = entries;
  }

  resolve(input: ModelResolutionInput): ResolvedModel {
    const reference = this.normalizeReference(input.reference, input.defaultProviderId);
    const provider = this.providers.get(reference.providerId);
    if (!provider) {
      throw new ModelResolutionError(
        'provider_unregistered',
        `Provider is not registered: ${reference.providerId}`,
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
    this.assertBindingConsistency(reference, provider, descriptor.identity.providerId, descriptor.protocol);
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
    const requestedMaxTokens = this.resolveMaxTokens(input);
    if (requestedMaxTokens.value > facts.maximumOutputTokens.value) {
      throw new ModelResolutionError(
        'capability_unsupported',
        'Requested output limit exceeds the Provider model capability.',
      );
    }
    const toolUse = facts.toolUse;
    if (input.request.tools && toolUse === undefined) {
      throw new ModelResolutionError(
        'facts_insufficient',
        'Tool Use capability is required but was not declared by the Provider.',
      );
    }
    if (input.request.tools && toolUse?.value !== true) {
      throw new ModelResolutionError(
        'capability_unsupported',
        'The selected model does not declare Tool Use support.',
      );
    }
    if (input.request.mediaKinds.length > 0) {
      const supported = facts.mediaKinds?.value;
      if (!supported) {
        throw new ModelResolutionError(
          'facts_insufficient',
          'Media capability is required but was not declared by the Provider.',
        );
      }
      if (input.request.mediaKinds.some((kind) => !supported.includes(kind))) {
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
        effectiveContextLimit: Object.freeze({ ...facts.effectiveContextLimit }),
        maximumOutputTokens: Object.freeze({ ...facts.maximumOutputTokens }),
        ...(facts.toolUse ? { toolUse: Object.freeze({ ...facts.toolUse }) } : {}),
        ...(facts.mediaKinds
          ? {
              mediaKinds: Object.freeze({
                ...facts.mediaKinds,
                value: Object.freeze([...facts.mediaKinds.value]),
              }),
            }
          : {}),
      }),
      limits: Object.freeze({
        maxTokens: requestedMaxTokens.value,
        maxTokensSource: requestedMaxTokens.source,
      }),
    });
  }

  private normalizeReference(
    reference: ModelResolutionInput['reference'],
    defaultProviderId?: string,
  ): CanonicalModelIdentity {
    const structured = typeof reference === 'string'
      ? { providerId: defaultProviderId, modelId: reference }
      : reference;
    const providerId = normalizeIdentityPart(structured?.providerId ?? defaultProviderId);
    const modelId = normalizeIdentityPart(structured?.modelId);
    if (!providerId || !modelId) {
      throw new ModelResolutionError('reference_invalid', 'A valid Provider and Model reference is required.');
    }
    return { providerId, modelId };
  }

  private assertBindingConsistency(
    reference: CanonicalModelIdentity,
    provider: ProviderProjectionEntry,
    descriptorProviderId: string,
    descriptorProtocol: string,
  ): void {
    if (
      normalizeIdentityPart(descriptorProviderId) !== reference.providerId
      || descriptorProtocol !== provider.protocol
    ) {
      throw new ModelResolutionError(
        'protocol_incompatible',
        'Provider identity, protocol, facts, and invocation binding are inconsistent.',
      );
    }
  }

  private requireFacts(facts: ProviderModelFacts): {
    effectiveContextLimit: SourcedFact<number>;
    maximumOutputTokens: SourcedFact<number>;
    toolUse?: SourcedFact<boolean>;
    mediaKinds?: SourcedFact<readonly string[]>;
  } {
    if (
      !isContextLimitFact(facts.effectiveContextLimit)
      || !isCapabilityLimitFact(facts.maximumOutputTokens)
      || (facts.toolUse !== undefined && !isCapabilityBooleanFact(facts.toolUse))
      || (facts.mediaKinds !== undefined && !isMediaKindsFact(facts.mediaKinds))
    ) {
      throw new ModelResolutionError(
        'facts_insufficient',
        'Provider model facts are missing an execution-critical positive limit or provenance.',
      );
    }
    return {
      effectiveContextLimit: facts.effectiveContextLimit,
      maximumOutputTokens: facts.maximumOutputTokens,
      ...(facts.toolUse ? { toolUse: facts.toolUse } : {}),
      ...(facts.mediaKinds ? { mediaKinds: facts.mediaKinds } : {}),
    };
  }

  private resolveMaxTokens(input: ModelResolutionInput): {
    value: number;
    source: 'policy-default' | 'request-override';
  } {
    if (!Number.isInteger(input.policy.defaultMaxTokens) || input.policy.defaultMaxTokens <= 0) {
      throw new ModelResolutionError('policy_denied', 'Model policy has an invalid default output limit.');
    }
    if (
      input.policy.maximumMaxTokens !== undefined
      && input.policy.defaultMaxTokens > input.policy.maximumMaxTokens
    ) {
      throw new ModelResolutionError('policy_denied', 'Model policy default exceeds its output limit.');
    }
    const override = input.requestOverride?.maxTokens;
    if (override === undefined) {
      return { value: input.policy.defaultMaxTokens, source: 'policy-default' };
    }
    if (!Number.isInteger(override) || override <= 0) {
      throw new ModelResolutionError('override_unauthorized', 'Output override must be a positive integer.');
    }
    if (input.policy.maximumMaxTokens !== undefined && override > input.policy.maximumMaxTokens) {
      throw new ModelResolutionError('override_unauthorized', 'Output override exceeds the policy limit.');
    }
    return { value: override, source: 'request-override' };
  }
}

function normalizeIdentityPart(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isContextLimitFact(
  fact: SourcedFact<number> | undefined,
): fact is SourcedFact<number> {
  return Boolean(
    fact
    && Number.isInteger(fact.value)
    && fact.value > 0
    && isFactSource(fact.source),
  );
}

function isCapabilityLimitFact(
  fact: SourcedFact<number> | undefined,
): fact is SourcedFact<number> {
  return Boolean(
    isContextLimitFact(fact)
    && fact.source !== 'provider-default'
    && fact.source !== 'legacy-config',
  );
}

function isCapabilityBooleanFact(
  fact: SourcedFact<boolean>,
): boolean {
  return (
    typeof fact.value === 'boolean'
    && isCapabilitySource(fact.source)
  );
}

function isMediaKindsFact(
  fact: SourcedFact<readonly string[]>,
): boolean {
  return (
    Array.isArray(fact.value)
    && fact.value.every((kind) => typeof kind === 'string' && kind.length > 0)
    && isCapabilitySource(fact.source)
  );
}

function isCapabilitySource(source: SourcedFact<unknown>['source']): boolean {
  return (
    source === 'deployment-config'
    || source === 'provider-metadata'
    || source === 'static-provider-catalog'
  );
}

function isFactSource(source: SourcedFact<unknown>['source']): boolean {
  return (
    isCapabilitySource(source)
    || source === 'provider-default'
    || source === 'legacy-config'
  );
}
