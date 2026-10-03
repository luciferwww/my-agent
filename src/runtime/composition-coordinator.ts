import type { RegistrySnapshot } from '../core/registry/index.js';
import type { RuntimeLifecycleLedger } from './runtime-lifecycle.js';

export interface RuntimeGenerationPin {
  readonly generation: number;
  readonly snapshot: RegistrySnapshot;
  release(): void;
}

export interface RuntimeSnapshotAccess {
  currentSnapshot(): RegistrySnapshot;
  captureRootGeneration(): RuntimeGenerationPin;
}

export interface PublishedGenerationChange {
  readonly previous?: RegistrySnapshot;
  readonly current: RegistrySnapshot;
  readonly retiringGeneration?: number;
  readonly retiringInstanceIds?: readonly string[];
}

export interface RuntimeGenerationView {
  readonly generation: number;
  readonly state: RuntimeGenerationState;
  readonly pinCount: number;
  readonly instanceIds: readonly string[];
  readonly failure?: string;
}

export type RuntimeGenerationState =
  | 'current'
  | 'retiring'
  | 'retired'
  | 'failed-residual';

interface RuntimeGenerationRecord {
  readonly snapshot: RegistrySnapshot;
  readonly instanceIds: readonly string[];
  state: RuntimeGenerationState;
  failure?: string;
}

export class CompositionCoordinator {
  private currentSnapshot?: RegistrySnapshot;
  private closing = false;
  private readonly pinCounts = new Map<number, number>();
  private readonly generations = new Map<number, RuntimeGenerationRecord>();
  private readonly zeroPinWaiters = new Map<number, Set<() => void>>();
  private retiringGeneration?: number;
  private criticalOperation?: string;

  constructor(private readonly lifecycleLedger?: RuntimeLifecycleLedger) {}

  get current(): RegistrySnapshot | undefined {
    return this.currentSnapshot;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  get retiring(): number | undefined {
    return this.retiringGeneration;
  }

  commitPublish(
    snapshot: RegistrySnapshot,
    instanceIds: readonly string[] = [],
  ): PublishedGenerationChange {
    return this.runCritical('publish', () => {
      if (this.closing) {
        throw new Error('Runtime composition is closing.');
      }
      if (this.retiringGeneration !== undefined) {
        throw new Error(`Registry generation ${this.retiringGeneration} is still retiring.`);
      }
      const previous = this.currentSnapshot;
      const expectedGeneration = previous ? previous.generation + 1 : 1;
      if (snapshot.generation !== expectedGeneration) {
        throw new Error(
          `Registry generation must be ${expectedGeneration}; received ${snapshot.generation}.`,
        );
      }
      const frozenInstanceIds = Object.freeze([...new Set(instanceIds)]);
      if (this.lifecycleLedger && !this.lifecycleLedger.canPublish(frozenInstanceIds)) {
        throw new Error('All Runtime instances must be handed off before publication.');
      }
      if (previous) {
        const previousRecord = this.requireGeneration(previous.generation);
        previousRecord.state = 'retiring';
        this.retiringGeneration = previous.generation;
      }
      this.lifecycleLedger?.addGenerationMemberships(frozenInstanceIds, snapshot.generation);
      this.currentSnapshot = snapshot;
      this.pinCounts.set(snapshot.generation, this.pinCounts.get(snapshot.generation) ?? 0);
      this.generations.set(snapshot.generation, {
        snapshot,
        instanceIds: frozenInstanceIds,
        state: 'current',
      });
      const retiringInstanceIds = previous
        ? this.requireGeneration(previous.generation).instanceIds
        : undefined;
      return Object.freeze({
        ...(previous ? { previous } : {}),
        current: snapshot,
        ...(previous ? { retiringGeneration: previous.generation } : {}),
        ...(retiringInstanceIds ? { retiringInstanceIds } : {}),
      });
    });
  }

  captureRootGeneration(): RuntimeGenerationPin {
    return this.runCritical('capture', () => {
      if (this.closing) {
        throw new Error('Runtime composition is closing.');
      }
      const snapshot = this.currentSnapshot;
      if (!snapshot) {
        throw new Error('Runtime composition has not published a Registry Snapshot.');
      }
      const generation = snapshot.generation;
      this.pinCounts.set(generation, (this.pinCounts.get(generation) ?? 0) + 1);
      let released = false;
      return Object.freeze({
        generation,
        snapshot,
        release: () => {
          const waiters = this.runCritical('pin-release', () => {
            if (released) return;
            released = true;
            const count = this.pinCounts.get(generation);
            if (count === undefined || count < 1) {
              throw new Error(`Registry generation ${generation} pin accounting underflow.`);
            }
            this.pinCounts.set(generation, count - 1);
            return count === 1 ? this.takeZeroPinWaiters(generation) : undefined;
          });
          for (const resolve of waiters ?? []) resolve();
        },
      });
    });
  }

  runReloadCommand<T>(operation: string, command: () => T): T {
    return this.runCritical(`reload:${operation}`, command);
  }

  beginShutdown(onAdmitted?: () => void): void {
    this.runCritical('shutdown-admission', () => {
      if (this.closing) return;
      this.closing = true;
      onAdmitted?.();
    });
  }

  pinCount(generation: number): number {
    return this.pinCounts.get(generation) ?? 0;
  }

  generationState(generation: number): RuntimeGenerationState | undefined {
    return this.generations.get(generation)?.state;
  }

  waitForZeroPins(generation: number): Promise<void> {
    this.requireGeneration(generation);
    if (this.pinCount(generation) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.zeroPinWaiters.get(generation) ?? new Set();
      waiters.add(resolve);
      this.zeroPinWaiters.set(generation, waiters);
    });
  }

  completeRetirement(generation: number): void {
    this.runCritical('retirement-complete', () => {
      const record = this.requireRetiringGeneration(generation);
      if (this.pinCount(generation) !== 0) {
        throw new Error(`Registry generation ${generation} still has active pins.`);
      }
      record.state = 'retired';
      this.retiringGeneration = undefined;
    });
  }

  failRetirement(generation: number, message: string): void {
    this.runCritical('retirement-fail', () => {
      const record = this.requireRetiringGeneration(generation);
      record.state = 'failed-residual';
      record.failure = message;
      this.retiringGeneration = undefined;
    });
  }

  retirementFailure(generation: number): string | undefined {
    return this.generations.get(generation)?.failure;
  }

  generationInstanceIds(generation: number): readonly string[] {
    return this.requireGeneration(generation).instanceIds;
  }

  generationViews(): readonly RuntimeGenerationView[] {
    return Object.freeze([...this.generations.entries()]
      .sort(([left], [right]) => left - right)
      .map(([generation, record]) => Object.freeze({
        generation,
        state: record.state,
        pinCount: this.pinCount(generation),
        instanceIds: record.instanceIds,
        ...(record.failure ? { failure: record.failure } : {}),
      })));
  }

  createSnapshotAccess(): RuntimeSnapshotAccess {
    return Object.freeze({
      currentSnapshot: () => {
        const snapshot = this.currentSnapshot;
        if (!snapshot) {
          throw new Error('Runtime composition has not published a Registry Snapshot.');
        }
        return snapshot;
      },
      captureRootGeneration: () => this.captureRootGeneration(),
    });
  }

  private runCritical<T>(operation: string, run: () => T): T {
    if (this.criticalOperation) {
      throw new Error(
        `Composition critical operation "${operation}" entered during "${this.criticalOperation}".`,
      );
    }
    this.criticalOperation = operation;
    try {
      return run();
    } finally {
      this.criticalOperation = undefined;
    }
  }

  private requireGeneration(generation: number): RuntimeGenerationRecord {
    const record = this.generations.get(generation);
    if (!record) throw new Error(`Unknown Registry generation ${generation}.`);
    return record;
  }

  private requireRetiringGeneration(generation: number): RuntimeGenerationRecord {
    const record = this.requireGeneration(generation);
    if (record.state !== 'retiring' || this.retiringGeneration !== generation) {
      throw new Error(`Registry generation ${generation} is not retiring.`);
    }
    return record;
  }

  private takeZeroPinWaiters(generation: number): readonly (() => void)[] | undefined {
    const waiters = this.zeroPinWaiters.get(generation);
    if (!waiters) return undefined;
    this.zeroPinWaiters.delete(generation);
    return [...waiters];
  }
}
