import type { ModelInvocationPort } from '../model-invocation/index.js';

export type ResolutionFailureCategory =
  | 'provider_unregistered'
  | 'connection_missing'
  | 'connection_invalid'
  | 'reference_invalid'
  | 'model_rejected'
  | 'model_ambiguous'
  | 'facts_insufficient'
  | 'policy_denied'
  | 'override_unauthorized'
  | 'protocol_incompatible'
  | 'capability_unsupported';

export type ModelFactSource =
  | 'deployment-config'
  | 'provider-metadata'
  | 'static-provider-catalog'
  | 'provider-default'
  | 'legacy-config';

export interface SourcedFact<T> {
  readonly value: T;
  readonly source: ModelFactSource;
}

export interface ModelReference {
  readonly providerId?: string;
  readonly modelId: string;
}

export type ModelReferenceSource =
  | 'native'
  | 'turn-explicit'
  | 'config-default';

export interface ModelRequestRequirements {
  readonly tools: boolean;
  readonly mediaKinds: readonly string[];
}

export interface ModelRequestOverride {
  readonly maxOutputTokens?: number;
}

export interface ModelPolicy {
  readonly defaultMaxTokens: number;
  readonly maximumMaxTokens?: number;
  readonly allowModel?: (identity: CanonicalModelIdentity) => boolean;
}

export interface CanonicalModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ProviderConnection {
  readonly endpointId: string;
  readonly deploymentId?: string;
}

export interface ProviderModelFacts {
  readonly effectiveContextLimit?: SourcedFact<number>;
  readonly maximumOutputTokens?: SourcedFact<number>;
  readonly toolUse?: SourcedFact<boolean>;
  readonly mediaKinds?: SourcedFact<readonly string[]>;
}

export interface ProviderModelDescriptor {
  readonly identity: CanonicalModelIdentity;
  readonly protocol: string;
  readonly connection: ProviderConnection;
  readonly facts: ProviderModelFacts;
}

export type ProviderConnectionResult =
  | { readonly ok: true; readonly connection: ProviderConnection }
  | {
      readonly ok: false;
      readonly category: 'connection_missing' | 'connection_invalid';
      readonly message: string;
    };

export type ProviderModelResult =
  | { readonly ok: true; readonly descriptor: ProviderModelDescriptor }
  | {
      readonly ok: false;
      readonly category: 'model_rejected' | 'model_ambiguous' | 'facts_insufficient';
      readonly message: string;
    };

export interface ProviderProjectionEntry {
  readonly id: string;
  readonly protocol: string;
  readonly invocationPort: ModelInvocationPort;
  resolveConnection(): ProviderConnectionResult;
  resolveModel(modelId: string, connection: ProviderConnection): ProviderModelResult;
}

export interface ModelResolutionInput {
  readonly reference: ModelReference | string | undefined;
  readonly referenceSource?: ModelReferenceSource;
  readonly defaultProviderId?: string;
  readonly request: ModelRequestRequirements;
  readonly requestOverride?: ModelRequestOverride;
  readonly policy: ModelPolicy;
}

export interface ResolvedModel {
  readonly identity: CanonicalModelIdentity;
  readonly referenceSource: ModelReferenceSource;
  readonly protocol: string;
  readonly endpointId: string;
  readonly deploymentId?: string;
  readonly invocationPort: ModelInvocationPort;
  readonly facts: Readonly<{
    effectiveContextLimit: SourcedFact<number>;
    maximumOutputTokens: SourcedFact<number>;
    toolUse?: SourcedFact<boolean>;
    mediaKinds?: SourcedFact<readonly string[]>;
  }>;
  readonly limits: Readonly<{
    maxTokens: number;
    maxTokensSource: 'policy-default' | 'request-override';
  }>;
}
