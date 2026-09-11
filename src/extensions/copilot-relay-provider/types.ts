import type { ProviderModelFacts } from '../../core/model-resolution/index.js';

export interface CopilotRelayProviderUnitOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly discoveryTimeoutMs?: number;
  /** Test seam; production uses global fetch. */
  readonly fetch?: typeof fetch;
}

export interface RelayModelMetadata {
  readonly id: string;
  readonly displayName?: string;
  readonly vendor?: string;
  readonly version?: string;
  readonly maximumPromptTokens: number;
  readonly maximumOutputTokens: number;
  readonly toolUse?: boolean;
  readonly vision?: boolean;
  readonly supportedImageMediaTypes: readonly string[];
}

export interface RelayModelBinding {
  readonly metadata: RelayModelMetadata;
  readonly facts: ProviderModelFacts;
}
