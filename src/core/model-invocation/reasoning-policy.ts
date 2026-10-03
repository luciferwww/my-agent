import type {
  ReasoningPreference,
  ResolvedReasoningPolicy,
  ThinkingEffort,
  ThinkingSwitch,
} from './types.js';

const THINKING_SWITCHES: ReadonlySet<ThinkingSwitch> = new Set(['on', 'off']);
const THINKING_EFFORTS: ReadonlySet<ThinkingEffort> = new Set([
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const REASONING_PREFERENCE_KEYS = new Set(['thinking', 'effort']);

export interface NormalizedReasoningPreference {
  readonly preference?: ReasoningPreference;
  readonly policy: ResolvedReasoningPolicy;
}

export class ReasoningPreferenceValidationError extends TypeError {
  constructor(readonly fieldPath: string) {
    super(`Reasoning preference field ${JSON.stringify(fieldPath)} is invalid.`);
    this.name = 'ReasoningPreferenceValidationError';
  }
}

export function normalizeReasoningPreference(
  value: unknown,
): NormalizedReasoningPreference {
  if (value === undefined) {
    return Object.freeze({
      policy: Object.freeze({ effort: 'default' }),
    });
  }
  if (!isPlainObject(value)) throw new ReasoningPreferenceValidationError('');

  for (const key of Object.keys(value)) {
    if (!REASONING_PREFERENCE_KEYS.has(key)) {
      throw new ReasoningPreferenceValidationError(key);
    }
  }

  const hasThinking = Object.prototype.hasOwnProperty.call(value, 'thinking');
  const hasEffort = Object.prototype.hasOwnProperty.call(value, 'effort');
  const thinking = hasThinking ? value['thinking'] : undefined;
  const effort = hasEffort ? value['effort'] : undefined;
  if (hasThinking && (typeof thinking !== 'string' || !THINKING_SWITCHES.has(thinking as ThinkingSwitch))) {
    throw new ReasoningPreferenceValidationError('thinking');
  }
  if (hasEffort && (typeof effort !== 'string' || !THINKING_EFFORTS.has(effort as ThinkingEffort))) {
    throw new ReasoningPreferenceValidationError('effort');
  }
  if (thinking === 'off' && effort !== undefined && effort !== 'default' && effort !== 'none') {
    throw new ReasoningPreferenceValidationError('effort');
  }
  if (thinking === 'on' && effort === 'none') {
    throw new ReasoningPreferenceValidationError('effort');
  }

  const preference: ReasoningPreference = Object.freeze({
    ...(thinking === undefined ? {} : { thinking: thinking as ThinkingSwitch }),
    ...(effort === undefined ? {} : { effort: effort as ThinkingEffort }),
  });
  return Object.freeze({
    preference,
    policy: Object.freeze({
      ...(thinking === undefined ? {} : { thinking: thinking as ThinkingSwitch }),
      effort: (effort ?? 'default') as ThinkingEffort,
    }),
  });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
