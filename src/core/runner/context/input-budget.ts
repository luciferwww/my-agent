import type { ResolvedModel } from '../../model-resolution/index.js';

const CONTEXT_HEADROOM_RATIO = 0.10;

type ModelLimitFacts = Pick<
  ResolvedModel['facts'],
  | 'effectiveContextLimit'
  | 'maximumContextTokens'
  | 'maximumPromptTokens'
  | 'maximumOutputTokens'
>;

export function resolveInputTokenBudget(
  facts: ModelLimitFacts,
  configuredReserveTokens: number,
  outputTokenLimit?: number,
): number {
  if (facts.maximumPromptTokens !== undefined) {
    return facts.maximumPromptTokens;
  }

  if (facts.maximumContextTokens !== undefined) {
    const proportionalHeadroom = Math.floor(
      facts.maximumContextTokens * CONTEXT_HEADROOM_RATIO,
    );
    const outputHeadroom = Math.min(
      configuredReserveTokens,
      proportionalHeadroom,
      outputTokenLimit
        ?? facts.maximumOutputTokens
        ?? Number.POSITIVE_INFINITY,
    );
    return Math.max(0, facts.maximumContextTokens - outputHeadroom);
  }

  return facts.effectiveContextLimit;
}
