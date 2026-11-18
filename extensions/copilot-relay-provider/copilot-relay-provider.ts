import type {
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
  ProviderConnection,
  ProviderProjectionEntry,
} from 'my-agent/extension-api';
import {
  COPILOT_RELAY_PROVIDER_ID,
  normalizeError,
} from './responses-client.js';
import type { RelayModelBinding, RelayWireProtocol } from './types.js';

export const COPILOT_RELAY_ROUTER_PROTOCOL = 'copilot-relay-model-router';

export class CopilotRelayProvider {
  readonly entry: ProviderProjectionEntry;

  constructor(
    endpointId: string,
    clients: ReadonlyMap<RelayWireProtocol, ModelInvocationPort>,
    models: ReadonlyMap<string, RelayModelBinding>,
    onModelNotFound: () => void = () => {},
  ) {
    const invocationPort = new CopilotRelayModelRouter(models, clients, onModelNotFound);
    const snapshot = Object.freeze({
      models: Object.freeze([...models.values()].map(({ metadata, facts }) => Object.freeze({
        modelId: metadata.id,
        ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
        ...((facts.toolUse !== undefined
          || facts.mediaKinds !== undefined
          || facts.reasoning !== undefined)
          ? {
              capabilities: Object.freeze({
                ...(facts.toolUse !== undefined ? { toolUse: facts.toolUse } : {}),
                ...(facts.mediaKinds !== undefined
                  ? { mediaKinds: Object.freeze([...facts.mediaKinds]) }
                  : {}),
                ...(facts.reasoning === undefined
                  ? {}
                  : { reasoning: facts.reasoning }),
              }),
            }
          : {}),
      }))),
      resolveModel: (modelId: string, connection: ProviderConnection) => {
        const model = models.get(modelId);
        if (!model) {
          return {
            ok: false,
            category: 'model_rejected',
            message: 'Copilot Relay Provider rejected a model outside its Catalog.',
          } as const;
        }
        return {
          ok: true,
          descriptor: Object.freeze({
            invocationPort,
            identity: Object.freeze({
              providerId: COPILOT_RELAY_PROVIDER_ID,
              modelId,
            }),
            protocol: COPILOT_RELAY_ROUTER_PROTOCOL,
            connection,
            facts: model.facts,
          }),
        } as const;
      },
    });
    this.entry = Object.freeze({
      id: COPILOT_RELAY_PROVIDER_ID,
      displayName: 'Copilot Relay',
      protocol: COPILOT_RELAY_ROUTER_PROTOCOL,
      getModelCatalog: async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return snapshot;
      },
      resolveConnection: () => Object.freeze({
        ok: true,
        connection: Object.freeze({ endpointId }),
      } as const),
    });
  }
}

class CopilotRelayModelRouter implements ModelInvocationPort {
  constructor(
    private readonly models: ReadonlyMap<string, RelayModelBinding>,
    private readonly clients: ReadonlyMap<RelayWireProtocol, ModelInvocationPort>,
    private readonly onModelNotFound: () => void,
  ) {}

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    try {
      for await (const event of this.resolveClient(request.model).chatStream(request)) {
        if (event.type === 'error') this.invalidate(event.error, request);
        yield event;
      }
    } catch (error) {
      this.invalidate(error, request);
      throw error;
    }
  }

  async chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    try {
      return await this.resolveClient(request.model).chat(request);
    } catch (error) {
      this.invalidate(error, request);
      throw error;
    }
  }

  private invalidate(error: unknown, request: ModelInvocationRequest): void {
    const normalized = normalizeError(error, request);
    if ('category' in normalized && normalized.category === 'model_not_found') this.onModelNotFound();
  }
  private resolveClient(modelId: string): ModelInvocationPort {
    const binding = this.models.get(modelId);
    if (!binding) {
      throw new Error(
        `Copilot Relay Provider has no binding for model ${JSON.stringify(modelId)}.`,
      );
    }
    const client = this.clients.get(binding.protocol);
    if (!client) {
      throw new Error(
        `Copilot Relay Provider has no Client for protocol ${JSON.stringify(binding.protocol)}.`,
      );
    }
    return client;
  }
}
