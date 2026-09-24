import { describe, expect, it } from 'vitest';
import { resolveInputTokenBudget } from './input-budget.js';

describe('resolveInputTokenBudget', () => {
  it('uses a known Prompt limit without subtracting output headroom again', () => {
    expect(resolveInputTokenBudget({
      effectiveContextLimit: 922_000,
      maximumContextTokens: 1_050_000,
      maximumPromptTokens: 922_000,
      maximumOutputTokens: 128_000,
    }, 20_000)).toBe(922_000);
  });

  it('bounds Context-only headroom by ten percent', () => {
    expect(resolveInputTokenBudget({
      effectiveContextLimit: 32_768,
      maximumContextTokens: 32_768,
    }, 20_000)).toBe(29_492);
  });

  it('bounds Context-only headroom by the known maximum output', () => {
    expect(resolveInputTokenBudget({
      effectiveContextLimit: 32_768,
      maximumContextTokens: 32_768,
      maximumOutputTokens: 2_048,
    }, 20_000)).toBe(30_720);
  });

  it('bounds Context-only headroom by configured policy', () => {
    expect(resolveInputTokenBudget({
      effectiveContextLimit: 100_000,
      maximumContextTokens: 100_000,
      maximumOutputTokens: 50_000,
    }, 4_096)).toBe(95_904);
  });

  it('does not reserve output when configured reserve is zero', () => {
    expect(resolveInputTokenBudget({
      effectiveContextLimit: 32_768,
      maximumContextTokens: 32_768,
      maximumOutputTokens: 8_192,
    }, 0)).toBe(32_768);
  });

  it('uses the Provider effective fallback when raw limits are unknown', () => {
    expect(resolveInputTokenBudget({
      effectiveContextLimit: 32_768,
    }, 20_000)).toBe(32_768);
  });
});
