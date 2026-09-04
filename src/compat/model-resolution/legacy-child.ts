import type { ModelResolver, ResolvedModel } from '../../core/model-resolution/index.js';

export interface LegacyChildModelInput {
  readonly model?: string;
}

export interface LegacyChildResolverOptions {
  readonly resolver: ModelResolver;
  readonly defaultProviderId: string;
  readonly defaultModel?: string;
  readonly defaultMaxTokens: number;
}

/**
 * Slice 1 → Slice 2 one-way compatibility boundary.
 * It maps legacy Child inputs into the same authoritative Resolver and never
 * manufactures Provider Facts or an invocation binding.
 */
export function createLegacyChildModelResolver(
  options: LegacyChildResolverOptions,
): (input: LegacyChildModelInput) => ResolvedModel {
  return (input) => options.resolver.resolve({
    reference: input.model && input.model !== 'inherit'
      ? input.model
      : options.defaultModel,
    referenceSource: 'legacy-child',
    defaultProviderId: options.defaultProviderId,
    request: { tools: false, mediaKinds: [] },
    policy: { defaultMaxTokens: options.defaultMaxTokens },
  });
}
