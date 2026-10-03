export interface ContextLimitCorrection {
  /** A conservative upper bound reported or inferred by the Provider adapter. */
  readonly effectiveContextLimit: number;
}

export type ModelInvocationFailureCategory =
  | 'authentication'
  | 'rate_limit'
  | 'invalid_request'
  | 'unavailable'
  | 'transport'
  | 'provider_failure';

interface ModelInvocationRequestDiagnostics {
  readonly model: string;
  readonly maxTokens?: number;
  readonly hasSystem: boolean;
  readonly messageCount: number;
  readonly userMessageCount: number;
  readonly assistantMessageCount: number;
  readonly stringContentMessageCount: number;
  readonly textBlockCount: number;
  readonly imageBlockCount: number;
  readonly toolUseBlockCount: number;
  readonly toolResultBlockCount: number;
  readonly toolDefinitionCount: number;
}

export interface ModelInvocationDiagnostics {
  readonly providerId: string;
  readonly httpStatus?: number;
  readonly providerErrorType?: string;
  readonly providerErrorCode?: string;
  readonly providerMessage?: string;
  readonly requestId?: string;
  readonly request: ModelInvocationRequestDiagnostics;
}

export interface ModelInvocationStructuralErrorV1 extends Error {
  readonly protocol: 'my-agent.model-invocation-error';
  readonly version: 1;
  readonly category: ModelInvocationFailureCategory;
  readonly diagnostics?: ModelInvocationDiagnostics;
}

const MODEL_INVOCATION_ERROR_PROTOCOL = 'my-agent.model-invocation-error';
const MODEL_INVOCATION_FAILURE_CATEGORIES = new Set<ModelInvocationFailureCategory>([
  'authentication',
  'rate_limit',
  'invalid_request',
  'unavailable',
  'transport',
  'provider_failure',
]);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const DIAGNOSTIC_STRING_MAX_LENGTH = 500;
const REQUEST_COUNT_FIELDS = [
  'messageCount',
  'userMessageCount',
  'assistantMessageCount',
  'stringContentMessageCount',
  'textBlockCount',
  'imageBlockCount',
  'toolUseBlockCount',
  'toolResultBlockCount',
  'toolDefinitionCount',
] as const;

export class ModelInvocationError extends Error implements ModelInvocationStructuralErrorV1 {
  readonly protocol = MODEL_INVOCATION_ERROR_PROTOCOL;
  readonly version = 1 as const;
  readonly diagnostics?: ModelInvocationDiagnostics;

  constructor(
    readonly category: ModelInvocationFailureCategory,
    diagnostics?: ModelInvocationDiagnostics,
  ) {
    super(`Model invocation failed: ${category}.`);
    this.name = 'ModelInvocationError';
    this.diagnostics = diagnostics
      ? Object.freeze({
          ...diagnostics,
          request: Object.freeze({ ...diagnostics.request }),
        })
      : undefined;
  }
}

export function toModelInvocationError(value: unknown): ModelInvocationError | undefined {
  try {
    if (value instanceof ModelInvocationError) return value;
    if (!(value instanceof Error)) return undefined;

    const protocol = readRequiredOwnDataProperty(value, 'protocol');
    const version = readRequiredOwnDataProperty(value, 'version');
    const category = readRequiredOwnDataProperty(value, 'category');
    if (
      protocol !== MODEL_INVOCATION_ERROR_PROTOCOL
      || version !== 1
      || !isModelInvocationFailureCategory(category)
    ) {
      return undefined;
    }

    const diagnostics = inspectOwnDataProperty(value, 'diagnostics');
    return new ModelInvocationError(
      category,
      diagnostics.state === 'data' ? canonicalizeDiagnostics(diagnostics.value) : undefined,
    );
  } catch {
    return undefined;
  }
}

function canonicalizeDiagnostics(value: unknown): ModelInvocationDiagnostics | undefined {
  if (!isRecord(value)) return undefined;

  const providerIdProperty = inspectOwnDataProperty(value, 'providerId');
  const requestProperty = inspectOwnDataProperty(value, 'request');
  if (
    providerIdProperty.state !== 'data'
    || typeof providerIdProperty.value !== 'string'
    || !PROVIDER_ID_PATTERN.test(providerIdProperty.value)
    || requestProperty.state !== 'data'
    || !isPlainRecord(requestProperty.value)
  ) {
    return undefined;
  }
  const providerId = providerIdProperty.value;
  const request = requestProperty.value;

  const modelProperty = inspectOwnDataProperty(request, 'model');
  const maxTokensProperty = inspectOwnDataProperty(request, 'maxTokens');
  const hasSystemProperty = inspectOwnDataProperty(request, 'hasSystem');
  if (modelProperty.state !== 'data' || typeof modelProperty.value !== 'string') return undefined;
  if (maxTokensProperty.state === 'accessor'
    || (maxTokensProperty.state === 'data'
      && (!Number.isSafeInteger(maxTokensProperty.value)
        || (maxTokensProperty.value as number) <= 0))) {
    return undefined;
  }
  if (hasSystemProperty.state !== 'data' || typeof hasSystemProperty.value !== 'boolean') {
    return undefined;
  }
  const model = modelProperty.value;
  const hasSystem = hasSystemProperty.value;

  const canonicalRequest: Record<string, string | number | boolean> = {
    model,
    ...(maxTokensProperty.state === 'data'
      ? { maxTokens: maxTokensProperty.value as number }
      : {}),
    hasSystem,
  };
  for (const field of REQUEST_COUNT_FIELDS) {
    const count = inspectOwnDataProperty(request, field);
    if (
      count.state !== 'data'
      || !Number.isSafeInteger(count.value)
      || (count.value as number) < 0
    ) {
      return undefined;
    }
    canonicalRequest[field] = count.value as number;
  }

  const httpStatus = inspectOwnDataProperty(value, 'httpStatus');
  if (
    httpStatus.state === 'accessor'
    || (httpStatus.state === 'data'
    && (!Number.isSafeInteger(httpStatus.value)
      || (httpStatus.value as number) < 100
      || (httpStatus.value as number) > 599))
  ) {
    return undefined;
  }

  const optionalStrings: Record<string, string> = {};
  for (const field of ['providerErrorType', 'providerErrorCode', 'providerMessage', 'requestId']) {
    const property = inspectOwnDataProperty(value, field);
    if (property.state === 'accessor') return undefined;
    if (property.state === 'data') {
      if (!isDiagnosticString(property.value)) return undefined;
      optionalStrings[field] = property.value;
    }
  }

  return Object.freeze({
    providerId,
    ...(httpStatus.state === 'data' ? { httpStatus: httpStatus.value as number } : {}),
    ...optionalStrings,
    request: Object.freeze(canonicalRequest) as unknown as ModelInvocationRequestDiagnostics,
  });
}

function readRequiredOwnDataProperty(value: object, key: PropertyKey): unknown {
  const property = inspectOwnDataProperty(value, key);
  if (property.state !== 'data') throw new TypeError(`Missing own data property: ${String(key)}`);
  return property.value;
}

function inspectOwnDataProperty(
  value: object,
  key: PropertyKey,
):
  | { readonly state: 'absent' }
  | { readonly state: 'accessor' }
  | { readonly state: 'data'; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { state: 'absent' };
  if (!('value' in descriptor)) return { state: 'accessor' };
  return { state: 'data', value: descriptor.value };
}

function isModelInvocationFailureCategory(value: unknown): value is ModelInvocationFailureCategory {
  return typeof value === 'string'
    && MODEL_INVOCATION_FAILURE_CATEGORIES.has(value as ModelInvocationFailureCategory);
}

function isDiagnosticString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= DIAGNOSTIC_STRING_MAX_LENGTH
    && !/[\r\n\t]/u.test(value);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class ContextOverflowError extends Error {
  readonly trigger: 'preemptive' | 'overflow';
  readonly correction?: ContextLimitCorrection;

  constructor(
    message: string,
    trigger: 'preemptive' | 'overflow' = 'overflow',
    correction?: ContextLimitCorrection,
  ) {
    super(message);
    this.name = 'ContextOverflowError';
    this.trigger = trigger;
    this.correction = correction;
  }
}
