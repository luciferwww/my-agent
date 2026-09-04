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

export class ModelInvocationError extends Error {
  constructor(readonly category: ModelInvocationFailureCategory) {
    super(`Model invocation failed: ${category}.`);
    this.name = 'ModelInvocationError';
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
