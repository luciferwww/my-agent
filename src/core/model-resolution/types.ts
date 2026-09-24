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

export interface ModelReference {
  readonly providerId: string;
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

export interface ModelPolicy {
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
  readonly effectiveContextLimit?: number;
  readonly maximumContextTokens?: number;
  readonly maximumPromptTokens?: number;
  readonly maximumOutputTokens?: number;
  readonly toolUse?: boolean;
  readonly mediaKinds?: readonly string[];
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

export interface ProviderCatalogModel {
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities?: {
    readonly toolUse?: boolean;
    readonly mediaKinds?: readonly string[];
  };
}

export interface ProviderProjectionEntry {
  readonly id: string;
  readonly displayName?: string;
  /** Catalog and resolveModel() must project the same immutable Provider-instance model snapshot. */
  readonly models: readonly ProviderCatalogModel[];
  readonly protocol: string;
  readonly invocationPort: ModelInvocationPort;
  resolveConnection(): ProviderConnectionResult;
  resolveModel(modelId: string, connection: ProviderConnection): ProviderModelResult;
}

export interface ModelResolutionInput {
  readonly reference: ModelReference | undefined;
  readonly referenceSource?: ModelReferenceSource;
  readonly request: ModelRequestRequirements;
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
    effectiveContextLimit: number;
    maximumContextTokens?: number;
    maximumPromptTokens?: number;
    maximumOutputTokens?: number;
    toolUse?: boolean;
    mediaKinds?: readonly string[];
  }>;
}
