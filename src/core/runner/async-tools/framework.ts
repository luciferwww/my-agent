import { randomUUID } from 'node:crypto';
import type { SessionManager } from '../../session/index.js';
import {
  TOOL_CANCELLATION_GRACE_MS,
  TOOL_IDLE_TIMEOUT_MS,
  TOOL_TOTAL_TIMEOUT_MS,
  type ExecutionCancelReason,
  type ExecutionOutcome,
  type ExecutionTerminalFact,
  type ToolExecutionOutput,
} from '../../tools/index.js';
import { bindToolTurnAuthority } from '../../tools/execution.js';
import type {
  AdmittedToolCall,
  AsyncToolExecutionFramework,
  TurnExecutionContext,
  TurnExecutionEvent,
} from './contracts.js';
import { ToolExecutionUnavailableError } from './contracts.js';
import {
  processToolExecutionRuntimeState,
  type ToolExecutionRuntimeState,
  type ToolExecutionSlotLease,
} from './runtime-state.js';

interface FrameworkOptions {
  readonly sessionManager: SessionManager;
  readonly runtimeState?: ToolExecutionRuntimeState;
  readonly now?: () => number;
  readonly createExecutionId?: () => string;
}

interface ExecutionEntry {
  readonly executionId: string;
  readonly unitId: string;
  readonly call: AdmittedToolCall;
  readonly context: TurnExecutionContext;
  readonly controller: AbortController;
  readonly slot: ToolExecutionSlotLease;
  readonly rootAbortListener: () => void;
  location: 'turn' | 'quarantine' | 'detached' | 'done';
  implementationStarted: boolean;
  promiseSettled: boolean;
  startedAt?: number;
  lastActiveAt?: number;
  cancellationReason?: ExecutionCancelReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  totalTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  terminalCandidate?: ExecutionTerminalFact;
  sealing: boolean;
}

export class DefaultAsyncToolExecutionFramework implements AsyncToolExecutionFramework {
  private readonly sessionManager: SessionManager;
  private readonly runtimeState: ToolExecutionRuntimeState;
  private readonly now: () => number;
  private readonly createExecutionId: () => string;
  private readonly executions = new Map<string, ExecutionEntry>();
  private readonly events: TurnExecutionEvent[] = [];
  private readonly waiters: Array<{
    resolve: (event: TurnExecutionEvent) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(options: FrameworkOptions) {
    this.sessionManager = options.sessionManager;
    this.runtimeState = options.runtimeState ?? processToolExecutionRuntimeState;
    this.now = options.now ?? Date.now;
    this.createExecutionId = options.createExecutionId ?? randomUUID;
  }

  async submit(
    call: AdmittedToolCall,
    context: TurnExecutionContext,
  ): Promise<{ readonly executionId: string; readonly status: 'accepted' }> {
    if (this.runtimeState.isUnitDisabled(call.unitId)) {
      throw new ToolExecutionUnavailableError(
        'registration_disabled',
        `Tool registration "${call.unitId}" is disabled until Host restart.`,
      );
    }
    const slot = this.runtimeState.tryReserveSlot();
    if (!slot) {
      throw new ToolExecutionUnavailableError(
        'capacity',
        'No Tool execution slot is currently available.',
      );
    }

    const executionId = this.createExecutionId();
    try {
      await this.sessionManager.appendToolExecutionAccepted(context.sessionId, {
        turnId: context.turnId,
        callId: call.callId,
        executionId,
        toolName: call.toolName,
      });
    } catch (error) {
      slot.release();
      throw error;
    }

    const controller = new AbortController();
    const rootAbortListener = () => {
      void this.cancel(executionId, 'root_abort');
    };
    const entry: ExecutionEntry = {
      executionId,
      unitId: call.unitId,
      call,
      context,
      controller,
      slot,
      rootAbortListener,
      location: 'turn',
      implementationStarted: false,
      promiseSettled: false,
      sealing: false,
    };
    this.executions.set(executionId, entry);
    context.signal.addEventListener('abort', rootAbortListener, { once: true });

    if (context.signal.aborted) {
      await this.sealTerminal(entry, {
        outcome: 'aborted',
        reason: 'start_interrupted',
        content: `Tool "${call.toolName}" was not executed because the Turn was aborted.`,
      }, false);
    } else {
      this.startExecution(entry);
    }

    return Object.freeze({ executionId, status: 'accepted' as const });
  }

  hasUnsettledWork(): boolean {
    return this.executions.size > 0 || this.events.length > 0;
  }

  async cancel(executionId: string, reason: ExecutionCancelReason): Promise<void> {
    const entry = this.executions.get(executionId);
    if (!entry || entry.location !== 'turn' || entry.terminalCandidate) return;
    if (entry.cancellationReason) return;

    entry.cancellationReason = reason;
    this.clearExecutionTimers(entry);
    entry.controller.abort(reason);
    entry.graceTimer = setTimeout(() => {
      void this.sealTerminal(entry, {
        outcome: 'outcome_unknown',
        reason: 'cancellation_grace_expired',
        content: `Tool "${entry.call.toolName}" did not settle within the cancellation grace period; termination and side effects are unknown.`,
      }, true);
    }, TOOL_CANCELLATION_GRACE_MS);
  }

  waitForNextEvent(signal: AbortSignal): Promise<TurnExecutionEvent> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    if (signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise<TurnExecutionEvent>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private startExecution(entry: ExecutionEntry): void {
    const startedAt = this.now();
    entry.startedAt = startedAt;
    entry.lastActiveAt = startedAt;
    entry.implementationStarted = true;
    this.scheduleIdleTimer(entry);
    entry.totalTimer = setTimeout(() => {
      void this.cancel(entry.executionId, 'total_timeout');
    }, TOOL_TOTAL_TIMEOUT_MS);

    let promise: Promise<ToolExecutionOutput>;
    try {
      promise = entry.call.execute(entry.call.input, bindToolTurnAuthority({
        sessionId: entry.context.sessionId,
        subagentDepth: entry.context.subagentDepth,
        turnId: entry.context.turnId,
        callId: entry.call.callId,
        executionId: entry.executionId,
        signal: entry.controller.signal,
        reportActivity: () => this.reportActivity(entry),
      }, entry.context.signal));
    } catch (error) {
      promise = Promise.reject(error);
    }

    void promise.then(
      (output) => this.handleSettlement(entry, {
        outcome: output.outcome,
        content: output.content,
      }),
      (error: unknown) => this.handleSettlement(entry, this.rejectionFact(entry, error)),
    );
  }

  private reportActivity(entry: ExecutionEntry): void {
    if (entry.location !== 'turn' || entry.promiseSettled || entry.terminalCandidate) return;
    entry.lastActiveAt = this.now();
    this.scheduleIdleTimer(entry);
  }

  private scheduleIdleTimer(entry: ExecutionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.cancel(entry.executionId, 'idle_timeout');
    }, TOOL_IDLE_TIMEOUT_MS);
  }

  private async handleSettlement(
    entry: ExecutionEntry,
    fact: ExecutionTerminalFact,
  ): Promise<void> {
    entry.promiseSettled = true;
    if (entry.location === 'detached') {
      entry.slot.release();
      entry.location = 'done';
      return;
    }
    if (entry.location === 'quarantine') {
      this.runtimeState.releaseQuarantine(entry.executionId);
      entry.location = 'done';
      return;
    }
    if (entry.location !== 'turn') return;
    if (entry.terminalCandidate?.outcome === 'outcome_unknown') return;

    this.clearExecutionTimers(entry);
    entry.slot.release();
    await this.sealTerminal(entry, fact, false);
  }

  private rejectionFact(entry: ExecutionEntry, error: unknown): ExecutionTerminalFact {
    if (entry.controller.signal.aborted) {
      return {
        outcome: 'aborted',
        reason: 'cancelled',
        content: `Tool "${entry.call.toolName}" was aborted.`,
      };
    }
    return {
      outcome: 'failed',
      content: `Error executing tool "${entry.call.toolName}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  private async sealTerminal(
    entry: ExecutionEntry,
    fact: ExecutionTerminalFact,
    quarantine: boolean,
  ): Promise<void> {
    if (entry.location !== 'turn' || entry.sealing) return;
    entry.terminalCandidate ??= fact;
    entry.sealing = true;
    if (!entry.implementationStarted) entry.slot.release();
    this.clearExecutionTimers(entry);

    try {
      await this.sessionManager.appendToolExecutionTerminal(entry.context.sessionId, {
        executionId: entry.executionId,
        ...entry.terminalCandidate,
      });
    } catch (error) {
      this.detachAfterFatalFailure(entry, quarantine);
      this.emitEvent({
        type: 'execution_persistence_failed',
        executionId: entry.executionId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    if (quarantine) {
      try {
        this.runtimeState.moveToQuarantine(entry);
      } catch (error) {
        this.detachAfterFatalFailure(entry, true, false);
        this.emitEvent({
          type: 'execution_invariant_failed',
          executionId: entry.executionId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }
      this.executions.delete(entry.executionId);
      entry.location = 'quarantine';
      if (entry.promiseSettled) {
        this.runtimeState.releaseQuarantine(entry.executionId);
        entry.location = 'done';
      }
    } else {
      this.executions.delete(entry.executionId);
      entry.location = 'done';
    }
    entry.context.signal.removeEventListener('abort', entry.rootAbortListener);

    this.emitEvent({
      type: 'execution_terminal',
      executionId: entry.executionId,
      callId: entry.call.callId,
      toolName: entry.call.toolName,
      input: entry.call.input,
      outcome: entry.terminalCandidate.outcome,
      content: entry.terminalCandidate.content,
      implementationStarted: entry.implementationStarted,
      ...(entry.startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, this.now() - entry.startedAt) }),
    });
  }

  private detachAfterFatalFailure(
    entry: ExecutionEntry,
    quarantine: boolean,
    attemptQuarantine = true,
  ): void {
    this.executions.delete(entry.executionId);
    entry.context.signal.removeEventListener('abort', entry.rootAbortListener);

    if (!quarantine || entry.promiseSettled) {
      entry.slot.release();
      entry.location = 'done';
      return;
    }

    if (attemptQuarantine) {
      try {
        this.runtimeState.moveToQuarantine(entry);
        entry.location = 'quarantine';
        return;
      } catch {
        // Fall through to a locally tracked detached execution.
      }
    }
    this.runtimeState.disableUnit(entry.unitId);
    entry.location = 'detached';
  }

  private clearExecutionTimers(entry: ExecutionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.totalTimer) clearTimeout(entry.totalTimer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.idleTimer = undefined;
    entry.totalTimer = undefined;
    entry.graceTimer = undefined;
  }

  private emitEvent(event: TurnExecutionEvent): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.events.push(event);
      return;
    }
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(event);
  }
}
