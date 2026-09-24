import type {
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import type {
  ProviderConnection,
  ProviderProjectionEntry,
} from '../../../core/model-resolution/index.js';
import { AnthropicMessagesClient } from './AnthropicMessagesClient.js';
import { OpenAIChatCompletionsClient } from './OpenAIChatCompletionsClient.js';
import { OpenAIResponsesClient } from './OpenAIResponsesClient.js';
import {
  DEFAULT_BUILTIN_CONTEXT_LIMIT,
  type BuiltinLlmProviderConfig,
  type BuiltinModelRegistration,
  type BuiltinProtocol,
} from './config.js';
import type { ProtocolClientOptions } from './client-common.js';

export const BUILTIN_PROVIDER_ID = 'builtin';
export const BUILTIN_PROVIDER_DISPLAY_NAME = 'Built-in LLM';
export const BUILTIN_MODEL_ROUTER_PROTOCOL = 'builtin-model-router';

export interface BuiltinLlmProviderOptions {
  readonly fetch?: typeof fetch;
  readonly createClient?: (
    protocol: BuiltinProtocol,
    options: ProtocolClientOptions,
  ) => ModelInvocationPort;
}

export class BuiltinLlmProvider {
  readonly entry: ProviderProjectionEntry;

  constructor(config: BuiltinLlmProviderConfig, options: BuiltinLlmProviderOptions = {}) {
    const capturedConfig = captureConfig(config);
    const protocols = new Set(capturedConfig.models.map((model) => model.protocol));
    const clients = new Map<BuiltinProtocol, ModelInvocationPort>();
    for (const protocol of protocols) {
      const clientOptions = Object.freeze({
        baseURL: capturedConfig.baseURL,
        ...(capturedConfig.apiKey === undefined ? {} : { apiKey: capturedConfig.apiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      clients.set(
        protocol,
        options.createClient?.(protocol, clientOptions)
          ?? createProtocolClient(protocol, clientOptions),
      );
    }
    const registrations = new Map(
      capturedConfig.models.map((model) => [model.modelId, model] as const),
    );
    const invocationPort = new BuiltinModelRouter(registrations, clients);

    this.entry = Object.freeze({
      id: BUILTIN_PROVIDER_ID,
      displayName: BUILTIN_PROVIDER_DISPLAY_NAME,
      models: Object.freeze(capturedConfig.models.map((model) => Object.freeze({
        modelId: model.modelId,
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
      }))),
      protocol: BUILTIN_MODEL_ROUTER_PROTOCOL,
      invocationPort,
      resolveConnection: () => ({
        ok: true,
        connection: Object.freeze({ endpointId: capturedConfig.baseURL }),
      } as const),
      resolveModel: (modelId: string, connection: ProviderConnection) => {
        const registration = registrations.get(modelId);
        if (!registration) {
          return {
            ok: false,
            category: 'model_rejected',
            message: 'Built-in LLM Provider rejected a model outside its Catalog.',
          } as const;
        }
        return {
          ok: true,
          descriptor: Object.freeze({
            identity: Object.freeze({ providerId: BUILTIN_PROVIDER_ID, modelId }),
            protocol: BUILTIN_MODEL_ROUTER_PROTOCOL,
            connection,
            facts: Object.freeze({
              effectiveContextLimit:
                registration.maximumPromptTokens
                ?? registration.maximumContextTokens
                ?? DEFAULT_BUILTIN_CONTEXT_LIMIT,
              ...(registration.maximumContextTokens === undefined
                ? {}
                : { maximumContextTokens: registration.maximumContextTokens }),
              ...(registration.maximumPromptTokens === undefined
                ? {}
                : { maximumPromptTokens: registration.maximumPromptTokens }),
              ...(registration.maximumOutputTokens === undefined
                ? {}
                : { maximumOutputTokens: registration.maximumOutputTokens }),
            }),
            ...(registration.outputTokenLimit === undefined
              ? {}
              : {
                  invocationDefaults: Object.freeze({
                    outputTokenLimit: resolveOutputTokenLimit(
                      registration.outputTokenLimit,
                      registration.maximumOutputTokens,
                    ),
                  }),
                }),
          }),
        } as const;
      },
    });
  }
}

export class BuiltinModelRouter implements ModelInvocationPort {
  constructor(
    private readonly registrations: ReadonlyMap<string, BuiltinModelRegistration>,
    private readonly clients: ReadonlyMap<BuiltinProtocol, ModelInvocationPort>,
  ) {}

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const { client, registration } = this.resolveRoute(request.model);
    yield* client.chatStream(withRegistrationDefaults(request, registration));
  }

  async chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const { client, registration } = this.resolveRoute(request.model);
    return await client.chat(withRegistrationDefaults(request, registration));
  }

  private resolveRoute(modelId: string): {
    client: ModelInvocationPort;
    registration: BuiltinModelRegistration;
  } {
    const registration = this.registrations.get(modelId);
    if (!registration) {
      throw new Error(`Built-in LLM Provider has no registration for model ${JSON.stringify(modelId)}.`);
    }
    const client = this.clients.get(registration.protocol);
    if (!client) {
      throw new Error(
        `Built-in LLM Provider has no Client for protocol ${JSON.stringify(registration.protocol)}.`,
      );
    }
    return { client, registration };
  }
}

function withRegistrationDefaults(
  request: ModelInvocationRequest,
  registration: BuiltinModelRegistration,
): ModelInvocationRequest {
  const requestedLimit = request.outputTokenLimit ?? registration.outputTokenLimit;
  if (requestedLimit === undefined) return request;
  return {
    ...request,
    outputTokenLimit: resolveOutputTokenLimit(
      requestedLimit,
      registration.maximumOutputTokens,
    ),
  };
}

function resolveOutputTokenLimit(
  outputTokenLimit: number,
  maximumOutputTokens: number | undefined,
): number {
  return maximumOutputTokens === undefined
    ? outputTokenLimit
    : Math.min(outputTokenLimit, maximumOutputTokens);
}

function createProtocolClient(
  protocol: BuiltinProtocol,
  options: ProtocolClientOptions,
): ModelInvocationPort {
  switch (protocol) {
    case 'anthropic-messages':
      return new AnthropicMessagesClient(options);
    case 'openai-responses':
      return new OpenAIResponsesClient(options);
    case 'openai-chat-completions':
      return new OpenAIChatCompletionsClient(options);
  }
}

function captureConfig(config: BuiltinLlmProviderConfig): BuiltinLlmProviderConfig {
  return Object.freeze({
    baseURL: config.baseURL,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    models: Object.freeze(config.models.map((model) => Object.freeze({ ...model }))),
  });
}
