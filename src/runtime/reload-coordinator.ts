import { randomUUID } from 'node:crypto';
import type {
  RuntimeCompositionResidual,
  RuntimeReloadChange,
  RuntimeReloadResult,
  RuntimeReloadWarning,
} from './runtime-composition.js';
import type { CompositionCoordinator } from './composition-coordinator.js';

export interface RuntimeReloadRequest {
  readonly requestId: string;
  readonly change: RuntimeReloadChange;
}

export type RuntimeReloadPreflight =
  | { readonly outcome: 'proceed' }
  | {
      readonly outcome: 'no-op';
      readonly warnings?: readonly RuntimeReloadWarning[];
    }
  | {
      readonly outcome: 'rejected';
      readonly category: string;
      readonly message: string;
      readonly warnings?: readonly RuntimeReloadWarning[];
    };

export interface PreparedRuntimeReload {
  readonly request: RuntimeReloadRequest;
  readonly warnings?: readonly RuntimeReloadWarning[];
}

export type RuntimeRetirementResult =
  | { readonly outcome: 'retired' }
  | {
      readonly outcome: 'failed-residual';
      readonly blocker: RuntimeCompositionResidual;
    };

export interface RuntimeReloadPublishResult {
  readonly previousGeneration: number;
  readonly generation: number;
  readonly retiredUnitIds: readonly string[];
}

export interface RuntimeReloadExecutionHooks<TPrepared extends PreparedRuntimeReload> {
  currentGeneration(): number;
  preflight(change: RuntimeReloadChange): RuntimeReloadPreflight;
  prepare(request: RuntimeReloadRequest, signal: AbortSignal): Promise<TPrepared>;
  cleanup(prepared: TPrepared): Promise<RuntimeCompositionResidual | undefined>;
  publish(prepared: TPrepared): RuntimeReloadPublishResult;
  retire(prepared: TPrepared): Promise<RuntimeRetirementResult>;
}

export interface RuntimeReloadDeadlineDriver {
  wait<T>(operation: Promise<T>, timeoutMs: number): Promise<
    | { readonly outcome: 'completed'; readonly value: T }
    | { readonly outcome: 'timed-out' }
  >;
}

export interface RuntimeReloadStateMachineOptions {
  readonly candidateCleanupTimeoutMs?: number;
  readonly deadlineDriver?: RuntimeReloadDeadlineDriver;
  readonly createRequestId?: () => string;
}

export class RuntimeReloadBlockedError extends Error {
  constructor(readonly blocker: RuntimeCompositionResidual) {
    super(blocker.message);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface PendingRequest {
  readonly request: RuntimeReloadRequest;
  readonly deferred: Deferred<RuntimeReloadResult>;
  readonly abortController: AbortController;
  readonly convergence: Deferred<RuntimeCompositionResidual | undefined>;
}

interface ActiveCandidate<TPrepared extends PreparedRuntimeReload> extends PendingRequest {
  prepared?: TPrepared;
  terminal?: 'superseded' | 'shutdown/cancelled';
  monitorStarted?: boolean;
}

type TransitionEffect = () => void;

interface Transition<T> {
  readonly value: T;
  readonly effects: readonly TransitionEffect[];
}

const DEFAULT_CANDIDATE_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Subordinate reload state reducer. CompositionCoordinator is the sole
 * linearization owner: every field transition below runs through its command
 * gate. Hooks, abort dispatch, Promise settlement, and async scheduling run
 * only after the command exits.
 */
export class RuntimeReloadStateMachine<TPrepared extends PreparedRuntimeReload> {
  private readonly createRequestId: () => string;
  private readonly cleanupTimeoutMs: number;
  private readonly deadlineDriver: RuntimeReloadDeadlineDriver;
  private active?: ActiveCandidate<TPrepared>;
  private retiring?: TPrepared;
  private pending?: PendingRequest;
  private blockedResidual?: RuntimeCompositionResidual;
  private closing = false;

  constructor(
    private readonly compositionCoordinator: CompositionCoordinator,
    private readonly hooks: RuntimeReloadExecutionHooks<TPrepared>,
    options: RuntimeReloadStateMachineOptions = {},
  ) {
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.cleanupTimeoutMs = options.candidateCleanupTimeoutMs
      ?? DEFAULT_CANDIDATE_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 1) {
      throw new Error('candidateCleanupTimeoutMs must be a positive safe integer.');
    }
    this.deadlineDriver = options.deadlineDriver ?? createSystemDeadlineDriver();
  }

  submit(change: RuntimeReloadChange): Promise<RuntimeReloadResult> {
    const pending = this.createPending(change);
    const generation = this.hooks.currentGeneration();
    this.transition('admission', () => {
      const effects: TransitionEffect[] = [];
      if (this.closing) {
        this.settle(effects, pending.deferred, this.shutdownResult(pending.request, generation));
      } else if (this.blockedResidual) {
        this.settle(
          effects,
          pending.deferred,
          this.blockedResult(pending.request, this.blockedResidual, generation),
        );
      } else if (this.active || this.retiring) {
        this.replacePending(pending, generation, effects);
        if (this.active && !this.active.terminal) {
          const active = this.active;
          active.terminal = 'superseded';
          effects.push(() => active.abortController.abort('superseded'));
          this.settle(effects, active.deferred, this.supersededResult(
            active.request,
            pending.request.requestId,
            generation,
          ));
          this.scheduleTerminalMonitor(active, effects);
        }
      } else {
        this.activate(pending, generation, effects);
      }
      return { value: undefined, effects };
    });
    return pending.deferred.promise;
  }

  beginShutdown(): void {
    const effects: TransitionEffect[] = [];
    let generation = 0;
    try {
      generation = this.hooks.currentGeneration();
    } catch {
      // Startup cleanup can close before generation 1 exists; no reload request
      // can have been admitted in that state.
    }
    this.compositionCoordinator.beginShutdown(() => {
      this.closing = true;
      if (this.pending) {
        this.settle(
          effects,
          this.pending.deferred,
          this.shutdownResult(this.pending.request, generation),
        );
        this.pending = undefined;
      }
      if (this.active && !this.active.terminal) {
        const active = this.active;
        active.terminal = 'shutdown/cancelled';
        effects.push(() => active.abortController.abort('shutdown'));
        this.settle(effects, active.deferred, this.shutdownResult(active.request, generation));
        this.scheduleTerminalMonitor(active, effects);
      }
    });
    this.applyEffects(effects);
  }

  get hasActiveCandidate(): boolean {
    return this.active !== undefined;
  }

  get hasRetiringGeneration(): boolean {
    return this.retiring !== undefined;
  }

  get pendingRequestId(): string | undefined {
    return this.pending?.request.requestId;
  }

  get blocker(): RuntimeCompositionResidual | undefined {
    return this.blockedResidual;
  }

  shutdownConvergence(): Promise<RuntimeCompositionResidual | undefined> {
    if (this.active) return this.active.convergence.promise;
    return Promise.resolve(this.blockedResidual);
  }

  private async runActive(active: ActiveCandidate<TPrepared>): Promise<void> {
    try {
      const preflight = this.hooks.preflight(active.request.change);
      const generation = this.hooks.currentGeneration();
      const shouldPrepare = this.transition('preflight-complete', () => {
        const effects: TransitionEffect[] = [];
        if (this.active !== active) return { value: false, effects };
        if (active.terminal) {
          this.settle(effects, active.convergence, undefined);
          return { value: false, effects };
        }
        if (preflight.outcome === 'no-op') {
          this.active = undefined;
          this.settle(effects, active.deferred, Object.freeze({
            requestId: active.request.requestId,
            outcome: 'no-op',
            change: active.request.change,
            generation,
            warnings: freezeWarnings(preflight.warnings),
          }));
          this.startPendingIfAvailable(generation, effects);
          return { value: false, effects };
        }
        if (preflight.outcome === 'rejected') {
          this.active = undefined;
          this.settle(effects, active.deferred, Object.freeze({
            requestId: active.request.requestId,
            outcome: 'rejected',
            change: active.request.change,
            generation,
            warnings: freezeWarnings(preflight.warnings),
            category: preflight.category,
            message: preflight.message,
          }));
          this.startPendingIfAvailable(generation, effects);
          return { value: false, effects };
        }
        return { value: true, effects };
      });
      if (!shouldPrepare) return;

      const prepared = await this.hooks.prepare(active.request, active.abortController.signal);
      const terminal = this.transition('candidate-prepared', () => {
        active.prepared = prepared;
        return { value: active.terminal !== undefined, effects: [] };
      });
      if (terminal) {
        await this.finishTerminalCleanup(active);
        return;
      }

      const publication = this.hooks.publish(prepared);
      this.transition('publish-complete', () => {
        const effects: TransitionEffect[] = [];
        this.active = undefined;
        this.retiring = prepared;
        this.settle(effects, active.deferred, Object.freeze({
          requestId: active.request.requestId,
          outcome: 'published',
          change: active.request.change,
          previousGeneration: publication.previousGeneration,
          generation: publication.generation,
          retiredUnitIds: Object.freeze([...publication.retiredUnitIds]),
          warnings: freezeWarnings(prepared.warnings),
        }));
        effects.push(() => { void this.runRetirement(prepared); });
        return { value: undefined, effects };
      });
    } catch (error) {
      await this.handleActiveError(active, error);
    }
  }

  private async finishTerminalCleanup(active: ActiveCandidate<TPrepared>): Promise<void> {
    const residual = active.prepared
      ? await this.hooks.cleanup(active.prepared).catch((error) => Object.freeze({
        phase: 'candidate-cleanup',
        requestId: active.request.requestId,
        unitId: active.request.change.unitId,
        message: messageOf(error),
      }))
      : undefined;
    this.transition('terminal-cleanup-complete', () => {
      const effects: TransitionEffect[] = [];
      this.settle(effects, active.convergence, residual);
      return { value: undefined, effects };
    });
  }

  private async cleanupPreparedWithinDeadline(
    active: ActiveCandidate<TPrepared>,
  ): Promise<RuntimeCompositionResidual | undefined> {
    const cleanup = this.hooks.cleanup(active.prepared!).catch((error) => Object.freeze({
      phase: 'candidate-cleanup',
      requestId: active.request.requestId,
      unitId: active.request.change.unitId,
      message: messageOf(error),
    }));
    const settled = await this.deadlineDriver.wait(cleanup, this.cleanupTimeoutMs);
    return settled.outcome === 'completed'
      ? settled.value
      : Object.freeze({
          phase: 'candidate-cleanup',
          requestId: active.request.requestId,
          unitId: active.request.change.unitId,
          message: `Candidate cleanup exceeded ${this.cleanupTimeoutMs}ms.`,
        });
  }

  private async waitForTerminalConvergence(active: ActiveCandidate<TPrepared>): Promise<void> {
    const settled = await this.deadlineDriver.wait(
      active.convergence.promise,
      this.cleanupTimeoutMs,
    );
    const residual = settled.outcome === 'completed'
      ? settled.value
      : Object.freeze({
          phase: 'candidate-cleanup',
          requestId: active.request.requestId,
          unitId: active.request.change.unitId,
          message: `Candidate cleanup exceeded ${this.cleanupTimeoutMs}ms.`,
        });
    const generation = this.hooks.currentGeneration();
    this.transition('terminal-convergence', () => {
      const effects: TransitionEffect[] = [];
      if (this.active === active) this.active = undefined;
      if (residual) this.block(residual, generation, effects);
      else this.startPendingIfAvailable(generation, effects);
      return { value: undefined, effects };
    });
  }

  private async runRetirement(prepared: TPrepared): Promise<void> {
    let result: RuntimeRetirementResult;
    try {
      result = await this.hooks.retire(prepared);
    } catch (error) {
      result = {
        outcome: 'failed-residual',
        blocker: Object.freeze({
          phase: 'retirement',
          requestId: prepared.request.requestId,
          message: messageOf(error),
        }),
      };
    }
    const generation = this.hooks.currentGeneration();
    this.transition('retirement-complete', () => {
      const effects: TransitionEffect[] = [];
      if (this.retiring !== prepared) return { value: undefined, effects };
      this.retiring = undefined;
      if (result.outcome === 'failed-residual') this.block(result.blocker, generation, effects);
      else this.startPendingIfAvailable(generation, effects);
      return { value: undefined, effects };
    });
  }

  private block(
    residual: RuntimeCompositionResidual,
    generation: number,
    effects: TransitionEffect[],
  ): void {
    this.blockedResidual = Object.freeze({ ...residual });
    if (this.pending) {
      this.settle(effects, this.pending.deferred, this.blockedResult(
        this.pending.request,
        this.blockedResidual,
        generation,
      ));
      this.pending = undefined;
    }
  }

  private replacePending(
    next: PendingRequest,
    generation: number,
    effects: TransitionEffect[],
  ): void {
    if (this.pending) {
      this.settle(effects, this.pending.deferred, this.supersededResult(
        this.pending.request,
        next.request.requestId,
        generation,
      ));
    }
    this.pending = next;
  }

  private startPendingIfAvailable(generation: number, effects: TransitionEffect[]): void {
    if (this.active || this.retiring || !this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    this.activate(pending, generation, effects);
  }

  private createPending(change: RuntimeReloadChange): PendingRequest {
    return {
      request: Object.freeze({
        requestId: this.createRequestId(),
        change: Object.freeze({ ...change }),
      }),
      deferred: createDeferred(),
      abortController: new AbortController(),
      convergence: createDeferred(),
    };
  }

  private activate(
    pending: PendingRequest,
    generation: number,
    effects: TransitionEffect[],
  ): void {
    if (this.closing) {
      this.settle(effects, pending.deferred, this.shutdownResult(pending.request, generation));
      return;
    }
    if (this.blockedResidual) {
      this.settle(
        effects,
        pending.deferred,
        this.blockedResult(
          pending.request,
          this.blockedResidual,
          generation,
        ),
      );
      return;
    }
    const active = pending as ActiveCandidate<TPrepared>;
    this.active = active;
    effects.push(() => { queueMicrotask(() => { void this.runActive(active); }); });
  }

  private scheduleTerminalMonitor(
    active: ActiveCandidate<TPrepared>,
    effects: TransitionEffect[],
  ): void {
    if (active.monitorStarted) return;
    active.monitorStarted = true;
    effects.push(() => { void this.waitForTerminalConvergence(active); });
  }

  private async handleActiveError(
    active: ActiveCandidate<TPrepared>,
    error: unknown,
  ): Promise<void> {
    if (error instanceof RuntimeReloadBlockedError) {
      const blocker = Object.freeze({
        ...error.blocker,
        requestId: active.request.requestId,
      });
      const generation = this.hooks.currentGeneration();
      this.transition('candidate-blocked', () => {
        const effects: TransitionEffect[] = [];
        if (active.terminal) {
          this.settle(effects, active.convergence, blocker);
        } else {
          this.active = undefined;
          this.settle(
            effects,
            active.deferred,
            this.blockedResult(active.request, blocker, generation),
          );
          this.block(blocker, generation, effects);
        }
        return { value: undefined, effects };
      });
      return;
    }
    if (active.terminal) {
      this.transition('terminal-candidate-failed', () => {
        const effects: TransitionEffect[] = [];
        this.settle(effects, active.convergence, undefined);
        return { value: undefined, effects };
      });
      return;
    }
    if (active.prepared) {
      const residual = await this.cleanupPreparedWithinDeadline(active);
      if (residual) {
        const generation = this.hooks.currentGeneration();
        this.transition('candidate-cleanup-blocked', () => {
          const effects: TransitionEffect[] = [];
          this.active = undefined;
          this.settle(
            effects,
            active.deferred,
            this.blockedResult(active.request, residual, generation),
          );
          this.block(residual, generation, effects);
          return { value: undefined, effects };
        });
        return;
      }
    }
    const generation = this.hooks.currentGeneration();
    this.transition('candidate-rejected', () => {
      const effects: TransitionEffect[] = [];
      this.active = undefined;
      this.settle(effects, active.deferred, Object.freeze({
        requestId: active.request.requestId,
        outcome: 'rejected',
        change: active.request.change,
        generation,
        warnings: Object.freeze([]),
        category: 'CANDIDATE_FAILED',
        message: messageOf(error),
      }));
      this.startPendingIfAvailable(generation, effects);
      return { value: undefined, effects };
    });
  }

  private transition<T>(operation: string, reduce: () => Transition<T>): T {
    const transition = this.compositionCoordinator.runReloadCommand(operation, reduce);
    this.applyEffects(transition.effects);
    return transition.value;
  }

  private applyEffects(effects: readonly TransitionEffect[]): void {
    for (const effect of effects) effect();
  }

  private settle<T>(effects: TransitionEffect[], deferred: Deferred<T>, value: T): void {
    effects.push(() => deferred.resolve(value));
  }

  private supersededResult(
    request: RuntimeReloadRequest,
    supersededByRequestId: string,
    generation: number,
  ): RuntimeReloadResult {
    return Object.freeze({
      requestId: request.requestId,
      outcome: 'superseded',
      change: request.change,
      generation,
      warnings: Object.freeze([]),
      supersededByRequestId,
    });
  }

  private blockedResult(
    request: RuntimeReloadRequest,
    blocker: RuntimeCompositionResidual,
    generation: number,
  ): RuntimeReloadResult {
    return Object.freeze({
      requestId: request.requestId,
      outcome: 'blocked',
      change: request.change,
      generation,
      warnings: Object.freeze([]),
      blocker,
    });
  }

  private shutdownResult(request: RuntimeReloadRequest, generation: number): RuntimeReloadResult {
    return Object.freeze({
      requestId: request.requestId,
      outcome: 'shutdown/cancelled',
      change: request.change,
      generation,
      warnings: Object.freeze([]),
    });
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function freezeWarnings(
  warnings: readonly RuntimeReloadWarning[] | undefined,
): readonly RuntimeReloadWarning[] {
  return Object.freeze((warnings ?? []).map((warning) => Object.freeze({ ...warning })));
}

function createSystemDeadlineDriver(): RuntimeReloadDeadlineDriver {
  return Object.freeze({
    wait<T>(operation: Promise<T>, timeoutMs: number) {
      return new Promise<
        | { readonly outcome: 'completed'; readonly value: T }
        | { readonly outcome: 'timed-out' }
      >((resolve, reject) => {
        const timer = setTimeout(() => resolve({ outcome: 'timed-out' }), timeoutMs);
        timer.unref?.();
        void operation.then(
          (value) => {
            clearTimeout(timer);
            resolve({ outcome: 'completed', value });
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
