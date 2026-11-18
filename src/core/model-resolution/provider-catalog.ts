import { normalizeReasoningCapabilities } from './reasoning-capabilities.js';
import type { ProviderProjectionEntry, ProviderModelSnapshot, ProviderCatalogModel, ProviderConnection } from './types.js';

export async function readProviderModelCatalog(
  provider: ProviderProjectionEntry,
  signal?: AbortSignal,
): Promise<ProviderModelSnapshot> {
  signal?.throwIfAborted();
  const snapshot = await provider.getModelCatalog(signal);
  signal?.throwIfAborted();
  if (!snapshot || !Array.isArray(snapshot.models) || typeof snapshot.resolveModel !== 'function') {
    throw new Error(`Provider "${provider.id}" returned an invalid model catalog.`);
  }
  const ids = new Set<string>();
  const models = snapshot.models.map((model): ProviderCatalogModel => {
    if (!model || typeof model.modelId !== 'string' || ids.has(model.modelId)) {
      throw new Error(`Provider "${provider.id}" returned an invalid or duplicate model identity.`);
    }
    ids.add(model.modelId);
    if (model.displayName !== undefined
      && (typeof model.displayName !== 'string' || model.displayName.trim() === '')) {
      throw new Error(`Provider "${provider.id}" returned an invalid model display name.`);
    }
    const capabilities = model.capabilities;
    if (capabilities !== undefined) {
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
        || (capabilities.toolUse !== undefined && typeof capabilities.toolUse !== 'boolean')
        || (capabilities.mediaKinds !== undefined
          && (!Array.isArray(capabilities.mediaKinds)
            || capabilities.mediaKinds.some((kind: unknown) => typeof kind !== 'string' || !kind)))) {
        throw new Error(`Provider "${provider.id}" returned invalid model capabilities.`);
      }
    }
    return Object.freeze({
      modelId: model.modelId,
      ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
      ...(capabilities === undefined ? {} : {
        capabilities: Object.freeze({
          ...(capabilities.toolUse === undefined ? {} : { toolUse: capabilities.toolUse }),
          ...(capabilities.mediaKinds === undefined ? {} : {
            mediaKinds: Object.freeze([...capabilities.mediaKinds]),
          }),
          ...(capabilities.reasoning === undefined ? {} : {
            reasoning: normalizeReasoningCapabilities(capabilities.reasoning),
          }),
        }),
      }),
    });
  });
  return Object.freeze({
    models: Object.freeze(models),
    resolveModel: (modelId: string, connection: ProviderConnection) => snapshot.resolveModel(modelId, connection),
  });
}
