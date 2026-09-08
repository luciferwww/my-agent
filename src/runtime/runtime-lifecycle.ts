import type { ContributionSource } from '../core/registry/index.js';
import type { RuntimeDeadlineBudget } from './runtime-deadline.js';

export type RuntimeInstanceState =
  | 'created'
  | 'starting'
  | 'ready'
  | 'handed-off'
  | 'stop-pending'
  | 'stopped'
  | 'stop-failed';

export interface RuntimeLifecycleOwner {
  stop(): void | Promise<void>;
}

export interface RuntimeInstanceDescriptor {
  readonly instanceId: string;
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly dependencies?: readonly string[];
  readonly owner?: RuntimeLifecycleOwner;
}

export interface RuntimeInstanceView {
  readonly instanceId: string;
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly dependencies: readonly string[];
  readonly state: RuntimeInstanceState;
  readonly generationMemberships: readonly number[];
  readonly stopAttempts: number;
  readonly stopError?: string;
}

export interface RuntimeLifecycleStopReport {
  readonly completed: readonly string[];
  readonly failed: readonly { readonly instanceId: string; readonly message: string }[];
  readonly pending: readonly string[];
  readonly skippedProtected: readonly string[];
}

export interface RuntimeLifecycleStopOptions {
  readonly retryFailed?: boolean;
  readonly budget?: RuntimeDeadlineBudget;
}

interface RuntimeInstanceRecord {
  readonly instanceId: string;
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly dependencies: readonly string[];
  readonly owner?: RuntimeLifecycleOwner;
  readonly generationMemberships: Set<number>;
  state: RuntimeInstanceState;
  stopAttempts: number;
  stopError?: string;
}

export class RuntimeLifecycleLedger {
  private readonly records = new Map<string, RuntimeInstanceRecord>();

  create(descriptor: RuntimeInstanceDescriptor): void {
    if (this.records.has(descriptor.instanceId)) {
      throw new Error(`Duplicate runtime instance "${descriptor.instanceId}".`);
    }
    this.records.set(descriptor.instanceId, {
      instanceId: descriptor.instanceId,
      unitId: descriptor.unitId,
      source: descriptor.source,
      dependencies: Object.freeze([...(descriptor.dependencies ?? [])]),
      owner: descriptor.owner,
      generationMemberships: new Set(),
      state: 'created',
      stopAttempts: 0,
    });
  }

  markStarting(instanceId: string): void {
    this.transition(instanceId, 'created', 'starting');
  }

  markReady(instanceId: string): void {
    this.transition(instanceId, 'starting', 'ready');
  }

  handoff(instanceId: string): void {
    this.transition(instanceId, 'ready', 'handed-off');
  }

  addGenerationMembership(instanceId: string, generation: number): void {
    const record = this.require(instanceId);
    if (record.state !== 'handed-off') {
      throw new Error(`Runtime instance "${instanceId}" must be handed off before publication.`);
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error(`Runtime generation must be a positive safe integer. Received: ${generation}`);
    }
    record.generationMemberships.add(generation);
  }

  removeGenerationMembership(instanceId: string, generation: number): void {
    this.require(instanceId).generationMemberships.delete(generation);
  }

  addGenerationMemberships(instanceIds: readonly string[], generation: number): void {
    if (!this.canPublish(instanceIds)) {
      throw new Error('All Runtime instances must be handed off before publication.');
    }
    for (const instanceId of instanceIds) this.addGenerationMembership(instanceId, generation);
  }

  removeGenerationMemberships(instanceIds: readonly string[], generation: number): void {
    for (const instanceId of instanceIds) this.removeGenerationMembership(instanceId, generation);
  }

  canPublish(instanceIds: readonly string[]): boolean {
    return instanceIds.every((instanceId) => this.require(instanceId).state === 'handed-off');
  }

  view(instanceId: string): RuntimeInstanceView {
    const record = this.require(instanceId);
    return Object.freeze({
      instanceId: record.instanceId,
      unitId: record.unitId,
      source: record.source,
      dependencies: record.dependencies,
      state: record.state,
      generationMemberships: Object.freeze([...record.generationMemberships].sort((a, b) => a - b)),
      stopAttempts: record.stopAttempts,
      ...(record.stopError ? { stopError: record.stopError } : {}),
    });
  }

  async stopEligible(
    instanceIds: readonly string[],
    options: RuntimeLifecycleStopOptions = {},
  ): Promise<RuntimeLifecycleStopReport> {
    const ordered = this.reverseDependencyOrder(instanceIds);
    const completed: string[] = [];
    const failed: Array<{ instanceId: string; message: string }> = [];
    const pending: string[] = [];
    const skippedProtected: string[] = [];

    for (const instanceId of ordered) {
      const record = this.require(instanceId);
      if (record.generationMemberships.size > 0) {
        skippedProtected.push(instanceId);
        continue;
      }
      if (record.state === 'stopped') continue;
      if (record.state === 'stop-pending') {
        pending.push(instanceId);
        continue;
      }
      if (record.state === 'stop-failed' && (!options.retryFailed || record.stopAttempts >= 2)) {
        continue;
      }
      if (record.state !== 'handed-off' && record.state !== 'stop-failed') {
        throw new Error(`Runtime instance "${instanceId}" is not eligible to stop from state "${record.state}".`);
      }
      if (options.budget && options.budget.remaining() <= 0) {
        pending.push(instanceId);
        continue;
      }
      record.state = 'stop-pending';
      record.stopAttempts += 1;
      const stop = Promise.resolve().then(() => record.owner?.stop());
      const settled = options.budget
        ? await options.budget.raceRemaining(stop)
        : await stop.then(
            () => ({ outcome: 'completed' as const, value: undefined }),
            (error: unknown) => ({ outcome: 'failed' as const, message: messageOf(error) }),
          );
      if (settled.outcome === 'completed') {
        record.state = 'stopped';
        record.stopError = undefined;
        completed.push(instanceId);
      } else if (settled.outcome === 'failed') {
        const message = settled.message;
        record.state = 'stop-failed';
        record.stopError = message;
        failed.push({ instanceId, message });
      } else {
        pending.push(instanceId);
        void stop.then(
          () => {
            record.state = 'stopped';
            record.stopError = undefined;
          },
          (error: unknown) => {
            record.state = 'stop-failed';
            record.stopError = messageOf(error);
          },
        );
      }
    }

    return Object.freeze({
      completed: Object.freeze(completed),
      failed: Object.freeze(failed.map((entry) => Object.freeze(entry))),
      pending: Object.freeze(pending),
      skippedProtected: Object.freeze(skippedProtected),
    });
  }

  private reverseDependencyOrder(instanceIds: readonly string[]): string[] {
    const selected = new Set(instanceIds);
    const byUnit = new Map<string, string[]>();
    for (const instanceId of selected) {
      const record = this.require(instanceId);
      const unitInstances = byUnit.get(record.unitId) ?? [];
      unitInstances.push(instanceId);
      byUnit.set(record.unitId, unitInstances);
    }
    for (const unitInstances of byUnit.values()) unitInstances.sort(compareOrdinal);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const startupOrder: string[] = [];
    const visit = (instanceId: string): void => {
      if (visited.has(instanceId)) return;
      if (visiting.has(instanceId)) {
        throw new Error(`Runtime unit dependency cycle includes "${this.require(instanceId).unitId}".`);
      }
      visiting.add(instanceId);
      const record = this.require(instanceId);
      for (const dependencyUnitId of [...record.dependencies].sort(compareOrdinal)) {
        for (const dependencyId of byUnit.get(dependencyUnitId) ?? []) visit(dependencyId);
      }
      visiting.delete(instanceId);
      visited.add(instanceId);
      startupOrder.push(instanceId);
    };

    for (const instanceId of [...selected].sort((left, right) =>
      compareOrdinal(this.require(left).unitId, this.require(right).unitId))) {
      visit(instanceId);
    }
    return startupOrder.reverse();
  }

  private transition(
    instanceId: string,
    expected: RuntimeInstanceState,
    next: RuntimeInstanceState,
  ): void {
    const record = this.require(instanceId);
    if (record.state !== expected) {
      throw new Error(
        `Runtime instance "${instanceId}" cannot transition from "${record.state}" to "${next}".`,
      );
    }
    record.state = next;
  }

  private require(instanceId: string): RuntimeInstanceRecord {
    const record = this.records.get(instanceId);
    if (!record) throw new Error(`Unknown runtime instance "${instanceId}".`);
    return record;
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
