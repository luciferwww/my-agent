import type { ResolvedModel } from '../new-core/resolved-model.js';

export function adaptLegacyModel(model: ResolvedModel): string {
  return model.id;
}
