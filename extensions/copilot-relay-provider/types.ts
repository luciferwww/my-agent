import type {
  ProviderModelFacts,
  ReasoningCapabilities,
} from 'my-agent/extension-api';

export type RelayWireProtocol =
  | 'openai-responses'
  | 'openai-chat-completions';

export interface CopilotRelayProviderUnitOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly discoveryTimeoutMs?: number;
  /** Test seam; production uses global fetch. */
  readonly fetch?: typeof fetch;
  readonly logger?: {
    warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  };
}

export interface RelayModelMetadata {
  readonly id: string;
  readonly displayName?: string;
  readonly vendor?: string;
  readonly version?: string;
  readonly effectiveContextLimit: number;
  readonly maximumContextTokens?: number;
  readonly maximumPromptTokens?: number;
  readonly maximumOutputTokens: number;
  readonly toolUse?: boolean;
  readonly vision?: boolean;
  readonly supportedImageMediaTypes: readonly string[];
  readonly reasoning?: ReasoningCapabilities;
}

export interface RelayModelBinding {
  readonly metadata: RelayModelMetadata;
  readonly facts: ProviderModelFacts;
  readonly protocol: RelayWireProtocol;
}
