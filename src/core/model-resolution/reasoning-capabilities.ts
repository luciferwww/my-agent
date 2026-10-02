import type {
  ExplicitThinkingEffort,
  ThinkingSwitch,
} from '../model-invocation/index.js';
import type { ReasoningCapabilities } from './types.js';

const THINKING_SWITCHES: ReadonlySet<ThinkingSwitch> = new Set(['on', 'off']);
const EXPLICIT_THINKING_EFFORTS: ReadonlySet<ExplicitThinkingEffort> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const REASONING_CAPABILITY_KEYS = new Set(['thinking', 'efforts']);

export class ReasoningCapabilitiesValidationError extends TypeError {
  constructor(readonly fieldPath: string) {
    super(`Reasoning capability field ${JSON.stringify(fieldPath)} is invalid.`);
    this.name = 'ReasoningCapabilitiesValidationError';
  }
}

export function normalizeReasoningCapabilities(value: unknown): ReasoningCapabilities {
  if (!isPlainObject(value)) throw new ReasoningCapabilitiesValidationError('');

  for (const key of Object.keys(value)) {
    if (!REASONING_CAPABILITY_KEYS.has(key)) {
      throw new ReasoningCapabilitiesValidationError(key);
    }
  }

  const thinking = normalizeStringArray<ThinkingSwitch>(
    value['thinking'],
    'thinking',
    THINKING_SWITCHES,
  );
  const efforts = normalizeStringArray<ExplicitThinkingEffort>(
    value['efforts'],
    'efforts',
    EXPLICIT_THINKING_EFFORTS,
  );
  return Object.freeze({
    ...(thinking === undefined ? {} : { thinking }),
    ...(efforts === undefined ? {} : { efforts }),
  });
}

function normalizeStringArray<T extends string>(
  value: unknown,
  fieldPath: string,
  allowed: ReadonlySet<string>,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ReasoningCapabilitiesValidationError(fieldPath);

  const seen = new Set<string>();
  const normalized = value.map((entry, index) => {
    if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) {
      throw new ReasoningCapabilitiesValidationError(`${fieldPath}[${index}]`);
    }
    seen.add(entry);
    return entry as T;
  });
  return Object.freeze(normalized);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
