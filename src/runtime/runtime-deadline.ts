import { performance } from 'node:perf_hooks';

export interface RuntimeDeadlinePolicy {
  readonly candidateCleanupMs: number;
  readonly retirementGracefulDrainMs: number;
  readonly retirementAbortConvergenceMs: number;
  readonly shutdownGracefulDrainMs: number;
  readonly shutdownAbortConvergenceMs: number;
  readonly shutdownOverallMs: number;
}

export type RuntimeDeadlineRaceResult<T> =
  | { readonly outcome: 'completed'; readonly value: T }
  | { readonly outcome: 'failed'; readonly message: string }
  | { readonly outcome: 'deadline-exhausted' };

export interface RuntimeDeadlineDriver {
  now(): number;
  race<T>(operation: Promise<T>, absoluteDeadline: number): Promise<RuntimeDeadlineRaceResult<T>>;
}

export const DEFAULT_RUNTIME_DEADLINE_POLICY: RuntimeDeadlinePolicy = Object.freeze({
  candidateCleanupMs: 5_000,
  retirementGracefulDrainMs: 30_000,
  retirementAbortConvergenceMs: 10_000,
  shutdownGracefulDrainMs: 30_000,
  shutdownAbortConvergenceMs: 10_000,
  shutdownOverallMs: 60_000,
});

export class RuntimeDeadlineBudget {
  readonly absoluteDeadline: number;

  constructor(
    readonly driver: RuntimeDeadlineDriver,
    readonly policy: RuntimeDeadlinePolicy,
    absoluteDeadline = driver.now() + policy.shutdownOverallMs,
  ) {
    this.absoluteDeadline = absoluteDeadline;
  }

  remaining(): number {
    return Math.max(0, this.absoluteDeadline - this.driver.now());
  }

  deadlineFor(capMs: number): number {
    return Math.min(this.absoluteDeadline, this.driver.now() + capMs);
  }

  race<T>(operation: Promise<T>, capMs: number): Promise<RuntimeDeadlineRaceResult<T>> {
    if (this.remaining() <= 0) return Promise.resolve({ outcome: 'deadline-exhausted' });
    return this.driver.race(operation, this.deadlineFor(capMs));
  }

  raceRemaining<T>(operation: Promise<T>): Promise<RuntimeDeadlineRaceResult<T>> {
    if (this.remaining() <= 0) return Promise.resolve({ outcome: 'deadline-exhausted' });
    return this.driver.race(operation, this.absoluteDeadline);
  }
}

export function resolveRuntimeDeadlinePolicy(
  override: Partial<RuntimeDeadlinePolicy> | undefined,
): RuntimeDeadlinePolicy {
  const policy = { ...DEFAULT_RUNTIME_DEADLINE_POLICY, ...override };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(policy);
}

export function createSystemRuntimeDeadlineDriver(): RuntimeDeadlineDriver {
  return Object.freeze({
    now: () => performance.now(),
    race<T>(operation: Promise<T>, absoluteDeadline: number) {
      const remainingMs = Math.max(0, absoluteDeadline - performance.now());
      return new Promise<RuntimeDeadlineRaceResult<T>>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ outcome: 'deadline-exhausted' });
        }, remainingMs);
        timer.unref?.();
        void operation.then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ outcome: 'completed', value });
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ outcome: 'failed', message: messageOf(error) });
          },
        );
      });
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
