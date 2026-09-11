import type {
  ProviderConnection,
  ProviderProjectionEntry,
} from '../../core/model-resolution/index.js';
import {
  COPILOT_RELAY_PROVIDER_ID,
  CopilotRelayResponsesClient,
  OPENAI_RESPONSES_PROTOCOL,
} from './responses-client.js';
import type { RelayModelBinding } from './types.js';

export class CopilotRelayProvider {
  readonly entry: ProviderProjectionEntry;

  constructor(
    endpointId: string,
    client: CopilotRelayResponsesClient,
    models: ReadonlyMap<string, RelayModelBinding>,
  ) {
    this.entry = Object.freeze({
      id: COPILOT_RELAY_PROVIDER_ID,
      displayName: 'Copilot Relay',
      models: Object.freeze([...models.values()].map(({ metadata }) => Object.freeze({
        modelId: metadata.id,
        ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      }))),
      protocol: OPENAI_RESPONSES_PROTOCOL,
      invocationPort: client,
      resolveConnection: () => Object.freeze({
        ok: true,
        connection: Object.freeze({ endpointId }),
      } as const),
      resolveModel: (modelId: string, connection: ProviderConnection) => {
        const canonicalModelId = modelId.trim();
        const model = models.get(canonicalModelId);
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
            identity: Object.freeze({
              providerId: COPILOT_RELAY_PROVIDER_ID,
              modelId: canonicalModelId,
            }),
            protocol: OPENAI_RESPONSES_PROTOCOL,
            connection,
            facts: model.facts,
          }),
        } as const;
      },
    });
  }
}
