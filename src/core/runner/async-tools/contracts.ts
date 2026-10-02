import type {
  ExecutionAcceptedReceipt,
  ExecutionCancelReason,
  ExecutionOutcome,
  SupervisedToolExecute,
} from '../../tools/execution.js';

export interface AdmittedToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly unitId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly execute: SupervisedToolExecute;
}

export interface TurnExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentDepth: number;
  readonly signal: AbortSignal;
}

export type TurnExecutionEvent =
  | {
      readonly type: 'execution_terminal';
      readonly executionId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly outcome: ExecutionOutcome;
      readonly content: string;
      readonly implementationStarted: boolean;
      readonly durationMs?: number;
    }
  | {
      readonly type: 'execution_persistence_failed';
      readonly executionId: string;
      readonly error: Error;
    }
  | {
      readonly type: 'execution_invariant_failed';
      readonly executionId: string;
      readonly error: Error;
    };

export class ToolExecutionUnavailableError extends Error {
  constructor(
    readonly reason: 'capacity' | 'registration_disabled',
    message: string,
  ) {
    super(message);
    this.name = 'ToolExecutionUnavailableError';
  }
}

export interface AsyncToolExecutionFramework {
  submit(
    call: AdmittedToolCall,
    context: TurnExecutionContext,
  ): Promise<ExecutionAcceptedReceipt>;
  waitForNextEvent(signal: AbortSignal): Promise<TurnExecutionEvent>;
  cancel(executionId: string, reason: ExecutionCancelReason): Promise<void>;
  hasUnsettledWork(): boolean;
}
