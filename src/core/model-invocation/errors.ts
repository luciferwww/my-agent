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
  readonly maxTokens: number;
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

interface ModelInvocationDiagnostics {
  readonly providerId: string;
  readonly httpStatus?: number;
  readonly providerErrorType?: string;
  readonly providerMessage?: string;
  readonly requestId?: string;
  readonly request: ModelInvocationRequestDiagnostics;
}

export class ModelInvocationError extends Error {
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
