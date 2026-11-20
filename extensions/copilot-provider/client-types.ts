import type {
  ProviderModelFacts,
  ReasoningCapabilities,
} from 'my-agent/extension-api';

export type CopilotWireProtocol =
  | 'openai-responses'
  | 'openai-chat-completions';

export interface CopilotModelMetadata {
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

export interface CopilotCatalogBinding {
  readonly metadata: CopilotModelMetadata;
  readonly facts: ProviderModelFacts;
  readonly protocol: CopilotWireProtocol;
}
