import type { ToolExecutionContext, ToolExecutionOutput } from './types.js';

const turnAuthoritySignals = new WeakMap<ToolExecutionContext, AbortSignal>();

export const MAX_TOOL_EXECUTION_SLOTS = 8;
export const TOOL_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
export const TOOL_TOTAL_TIMEOUT_MS = 60 * 60 * 1_000;
export const TOOL_CANCELLATION_GRACE_MS = 10 * 1_000;

export type ExecutionOutcome =
  | 'success'
  | 'failed'
  | 'aborted'
  | 'outcome_unknown';

export type ExecutionCancelReason =
  | 'idle_timeout'
  | 'total_timeout'
  | 'root_abort'
  | 'shutdown';

export type ExecutionTerminalReason =
  | 'cancelled'
  | 'start_interrupted'
  | 'cancellation_grace_expired'
  | 'host_recovery';

export type ExecutionTerminalFact =
  | {
      readonly outcome: 'success' | 'failed';
      readonly content: string;
      readonly reason?: never;
    }
  | {
      readonly outcome: 'aborted';
      readonly content: string;
      readonly reason: 'cancelled' | 'start_interrupted';
    }
  | {
      readonly outcome: 'outcome_unknown';
      readonly content: string;
      readonly reason: 'cancellation_grace_expired' | 'host_recovery';
    };

export interface ExecutionAcceptedReceipt {
  readonly executionId: string;
  readonly status: 'accepted';
}

export interface HostTaskCompletion {
  readonly executionId: string;
  readonly toolName: string;
  readonly status: 'success' | 'failed' | 'aborted';
  readonly content: string;
}

/**
 * Internal execution context used by the async framework. The public Tool
 * interface moves to this context with the Extension API migration.
 */
export type SupervisedToolExecutionContext = ToolExecutionContext;

export function bindToolTurnAuthority<T extends ToolExecutionContext>(
  context: T,
  turnSignal: AbortSignal,
): T {
  turnAuthoritySignals.set(context, turnSignal);
  return context;
}

export function getToolTurnAuthority(context: ToolExecutionContext): AbortSignal {
  return turnAuthoritySignals.get(context) ?? context.signal;
}

export type SupervisedToolExecute = (
  params: Readonly<Record<string, unknown>>,
  context: SupervisedToolExecutionContext,
) => Promise<ToolExecutionOutput>;
