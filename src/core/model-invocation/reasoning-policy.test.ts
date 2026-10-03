import { describe, expect, it } from 'vitest';
import {
  normalizeReasoningPreference,
  ReasoningPreferenceValidationError,
} from './reasoning-policy.js';

describe('reasoning preference normalization', () => {
  it('distinguishes omission, an empty object, and explicit default', () => {
    const omitted = normalizeReasoningPreference(undefined);
    const empty = normalizeReasoningPreference({});
    const explicit = normalizeReasoningPreference({ effort: 'default' });

    expect(omitted).toEqual({ policy: { effort: 'default' } });
    expect(empty).toEqual({ preference: {}, policy: { effort: 'default' } });
    expect(explicit).toEqual({
      preference: { effort: 'default' },
      policy: { effort: 'default' },
    });
    expect(Object.isFrozen(empty.preference)).toBe(true);
    expect(Object.isFrozen(explicit.policy)).toBe(true);
  });

  it.each([
    [{ thinking: 'on' }, { thinking: 'on', effort: 'default' }],
    [{ thinking: 'off', effort: 'none' }, { thinking: 'off', effort: 'none' }],
    [{ effort: 'minimal' }, { effort: 'minimal' }],
    [{ effort: 'low' }, { effort: 'low' }],
    [{ effort: 'medium' }, { effort: 'medium' }],
    [{ effort: 'high' }, { effort: 'high' }],
    [{ effort: 'xhigh' }, { effort: 'xhigh' }],
    [{ effort: 'max' }, { effort: 'max' }],
  ] as const)('normalizes %j', (preference, policy) => {
    expect(normalizeReasoningPreference(preference)).toEqual({
      preference,
      policy,
    });
  });

  it.each([
    null,
    [],
    true,
    { effrot: 'high' },
    { thinking: true },
    { thinking: 'default' },
    { effort: 'ultra' },
    { thinking: 'on', effort: 'none' },
    { thinking: 'off', effort: 'minimal' },
  ])('rejects invalid preference %j', (preference) => {
    expect(() => normalizeReasoningPreference(preference))
      .toThrow(ReasoningPreferenceValidationError);
  });

  it('reads only own fields and accepts a null-prototype JSON-like object', () => {
    const preference = Object.create(null) as Record<string, unknown>;
    preference.effort = 'high';
    expect(normalizeReasoningPreference(preference)).toEqual({
      preference: { effort: 'high' },
      policy: { effort: 'high' },
    });

    const inherited = Object.create({ effort: 'high' });
    expect(() => normalizeReasoningPreference(inherited))
      .toThrow(ReasoningPreferenceValidationError);
  });
});
