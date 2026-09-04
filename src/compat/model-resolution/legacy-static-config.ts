import type { ModelResolver, ResolvedModel } from '../../core/model-resolution/index.js';

export interface LegacyParentModelInput {
  readonly model?: string;
  readonly maxTokens?: number;
  readonly tools: boolean;
  readonly mediaKinds: readonly string[];
}

export interface LegacyStaticResolverOptions {
  readonly resolver: ModelResolver;
  readonly defaultProviderId: string;
  readonly defaultModel?: string;
  readonly defaultMaxTokens: number;
}

/** Maps legacy static/Turn fields into the authoritative Parent Resolver input. */
export function createLegacyStaticModelResolver(
  options: LegacyStaticResolverOptions,
): (input: LegacyParentModelInput) => ResolvedModel {
  return (input) => options.resolver.resolve({
    reference: input.model ?? options.defaultModel,
    referenceSource: input.model !== undefined ? 'turn-explicit' : 'config-default',
    defaultProviderId: options.defaultProviderId,
    request: {
      tools: input.tools,
      mediaKinds: input.mediaKinds,
    },
    policy: { defaultMaxTokens: options.defaultMaxTokens },
    ...(input.maxTokens !== undefined
      ? { requestOverride: { maxTokens: input.maxTokens } }
      : {}),
  });
}
