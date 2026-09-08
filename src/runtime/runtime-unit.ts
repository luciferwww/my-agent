import type { ContributionSource, RuntimeContributionUnit } from '../core/registry/index.js';
import type { RuntimeReloadChange } from './runtime-composition.js';

const UNIT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface LoadedRuntimeUnit {
  readonly unitId: string;
  readonly source: ContributionSource;
  readonly orderKey: string;
  readonly required: boolean;
  readonly initiallyEnabled: boolean;
  readonly dependencies: readonly string[];
  create(signal: AbortSignal): RuntimeUnitInstance | Promise<RuntimeUnitInstance>;
}

export interface RuntimeUnitInstance {
  readonly registration: RuntimeContributionUnit;
  start(signal: AbortSignal): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type RuntimeUnitChangePlan =
  | Readonly<{
      outcome: 'proceed';
      desiredUnitIds: readonly string[];
    }>
  | Readonly<{
      outcome: 'no-op';
      code: 'ALREADY_SATISFIED';
      message: string;
    }>
  | Readonly<{
      outcome: 'rejected';
      category:
        | 'UNIT_UNKNOWN'
        | 'UNIT_REQUIRED'
        | 'UNIT_DEPENDENCY_INACTIVE'
        | 'UNIT_REQUIRED_BY_ACTIVE';
      message: string;
    }>;

export class RuntimeUnitCatalog {
  private readonly byId: ReadonlyMap<string, LoadedRuntimeUnit>;
  private readonly startupIds: readonly string[];

  constructor(units: readonly LoadedRuntimeUnit[]) {
    const byId = new Map<string, LoadedRuntimeUnit>();
    for (const unit of units) {
      assertUnitMetadata(unit);
      if (byId.has(unit.unitId)) {
        throw new Error(`Duplicate loaded Runtime Unit "${unit.unitId}".`);
      }
      byId.set(unit.unitId, freezeUnit(unit));
    }
    assertDependencies(byId);
    this.byId = byId;
    const startupIds = [...byId.values()]
      .filter((unit) => unit.initiallyEnabled)
      .map((unit) => unit.unitId);
    const startupSet = new Set(startupIds);
    for (const unitId of startupIds) {
      const unit = byId.get(unitId)!;
      const inactiveDependency = unit.dependencies.find((dependency) => !startupSet.has(dependency));
      if (inactiveDependency) {
        throw new Error(
          `Initially enabled Runtime Unit "${unitId}" requires disabled Unit "${inactiveDependency}".`,
        );
      }
    }
    this.startupIds = this.orderUnitIds(startupIds);
    for (const unit of byId.values()) {
      if (unit.required && !unit.initiallyEnabled) {
        throw new Error(`Required Runtime Unit "${unit.unitId}" must be initially enabled.`);
      }
    }
  }

  get(unitId: string): LoadedRuntimeUnit | undefined {
    return this.byId.get(unitId);
  }

  initialUnitIds(): readonly string[] {
    return this.startupIds;
  }

  orderedUnits(unitIds: readonly string[]): readonly LoadedRuntimeUnit[] {
    return Object.freeze(this.orderUnitIds(unitIds).map((unitId) => this.byId.get(unitId)!));
  }

  planChange(
    change: RuntimeReloadChange,
    activeUnitIds: ReadonlySet<string>,
  ): RuntimeUnitChangePlan {
    const unit = this.byId.get(change.unitId);
    if (!unit) {
      return Object.freeze({
        outcome: 'rejected',
        category: 'UNIT_UNKNOWN',
        message: `Runtime Unit "${change.unitId}" is not in the loaded catalog.`,
      });
    }

    const isActive = activeUnitIds.has(change.unitId);
    if ((change.operation === 'enable' && isActive)
      || (change.operation === 'disable' && !isActive)) {
      return Object.freeze({
        outcome: 'no-op',
        code: 'ALREADY_SATISFIED',
        message: `Runtime Unit "${change.unitId}" is already ${isActive ? 'enabled' : 'disabled'}.`,
      });
    }

    if (change.operation === 'enable') {
      const inactiveDependency = unit.dependencies.find((dependency) => !activeUnitIds.has(dependency));
      if (inactiveDependency) {
        return Object.freeze({
          outcome: 'rejected',
          category: 'UNIT_DEPENDENCY_INACTIVE',
          message: `Runtime Unit "${change.unitId}" requires inactive Unit "${inactiveDependency}".`,
        });
      }
      return Object.freeze({
        outcome: 'proceed',
        desiredUnitIds: this.orderUnitIds([...activeUnitIds, change.unitId]),
      });
    }

    if (unit.required) {
      return Object.freeze({
        outcome: 'rejected',
        category: 'UNIT_REQUIRED',
        message: `Required Runtime Unit "${change.unitId}" cannot be disabled.`,
      });
    }
    const dependent = [...activeUnitIds]
      .map((unitId) => this.byId.get(unitId)!)
      .sort(compareUnits)
      .find((candidate) => candidate.dependencies.includes(change.unitId));
    if (dependent) {
      return Object.freeze({
        outcome: 'rejected',
        category: 'UNIT_REQUIRED_BY_ACTIVE',
        message: `Runtime Unit "${change.unitId}" is required by active Unit "${dependent.unitId}".`,
      });
    }
    return Object.freeze({
      outcome: 'proceed',
      desiredUnitIds: this.orderUnitIds(
        [...activeUnitIds].filter((unitId) => unitId !== change.unitId),
      ),
    });
  }

  private orderUnitIds(unitIds: readonly string[]): readonly string[] {
    const selected = new Set<string>();
    for (const unitId of unitIds) {
      if (!this.byId.has(unitId)) {
        throw new Error(`Runtime Unit "${unitId}" is not in the loaded catalog.`);
      }
      selected.add(unitId);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const ordered: string[] = [];
    const visit = (unitId: string): void => {
      if (visited.has(unitId)) return;
      if (visiting.has(unitId)) {
        throw new Error(`Runtime Unit dependency cycle includes "${unitId}".`);
      }
      visiting.add(unitId);
      const unit = this.byId.get(unitId)!;
      for (const dependency of unit.dependencies) {
        if (selected.has(dependency)) visit(dependency);
      }
      visiting.delete(unitId);
      visited.add(unitId);
      ordered.push(unitId);
    };

    for (const unitId of [...selected].sort((left, right) =>
      compareUnits(this.byId.get(left)!, this.byId.get(right)!))) {
      visit(unitId);
    }
    return Object.freeze(ordered);
  }
}

export function createLoadedRuntimeUnit(params: {
  readonly registration: RuntimeContributionUnit;
  readonly required: boolean;
  readonly initiallyEnabled?: boolean;
  readonly dependencies?: readonly string[];
  readonly start?: (signal: AbortSignal) => void | Promise<void>;
  readonly stop?: () => void | Promise<void>;
}): LoadedRuntimeUnit {
  const { registration } = params;
  return Object.freeze({
    unitId: registration.id,
    source: registration.source,
    orderKey: registration.orderKey ?? registration.id,
    required: params.required,
    initiallyEnabled: params.initiallyEnabled ?? true,
    dependencies: Object.freeze([...(params.dependencies ?? [])]),
    create: () => Object.freeze({
      registration,
      start: params.start ?? (() => {}),
      stop: params.stop ?? (() => {}),
    }),
  });
}

function assertUnitMetadata(unit: LoadedRuntimeUnit): void {
  if (!UNIT_ID.test(unit.unitId)) {
    throw new Error(`Runtime Unit identity "${unit.unitId}" must match ${UNIT_ID.source}.`);
  }
  if (unit.source !== 'builtin' && unit.source !== 'external') {
    throw new Error(`Runtime Unit "${unit.unitId}" has invalid source "${String(unit.source)}".`);
  }
  if (typeof unit.orderKey !== 'string' || unit.orderKey.length === 0) {
    throw new Error(`Runtime Unit "${unit.unitId}" must have a non-empty orderKey.`);
  }
  if (typeof unit.create !== 'function') {
    throw new Error(`Runtime Unit "${unit.unitId}" must provide create().`);
  }
  const dependencyIds = new Set<string>();
  for (const dependency of unit.dependencies) {
    if (!UNIT_ID.test(dependency)) {
      throw new Error(`Runtime Unit "${unit.unitId}" has invalid dependency "${dependency}".`);
    }
    if (dependency === unit.unitId) {
      throw new Error(`Runtime Unit "${unit.unitId}" cannot depend on itself.`);
    }
    if (dependencyIds.has(dependency)) {
      throw new Error(`Runtime Unit "${unit.unitId}" repeats dependency "${dependency}".`);
    }
    dependencyIds.add(dependency);
  }
}

function assertDependencies(byId: ReadonlyMap<string, LoadedRuntimeUnit>): void {
  for (const unit of byId.values()) {
    for (const dependency of unit.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`Runtime Unit "${unit.unitId}" requires unknown Unit "${dependency}".`);
      }
    }
  }
  const allIds = [...byId.keys()];
  const selected = new Set(allIds);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (unitId: string): void => {
    if (visited.has(unitId)) return;
    if (visiting.has(unitId)) {
      throw new Error(`Runtime Unit dependency cycle includes "${unitId}".`);
    }
    visiting.add(unitId);
    for (const dependency of byId.get(unitId)!.dependencies) {
      if (selected.has(dependency)) visit(dependency);
    }
    visiting.delete(unitId);
    visited.add(unitId);
  };
  for (const unitId of allIds) visit(unitId);
}

function freezeUnit(unit: LoadedRuntimeUnit): LoadedRuntimeUnit {
  return Object.freeze({
    ...unit,
    dependencies: Object.freeze([...unit.dependencies]),
  });
}

function compareUnits(left: LoadedRuntimeUnit, right: LoadedRuntimeUnit): number {
  if (left.source !== right.source) return left.source === 'builtin' ? -1 : 1;
  return compareOrdinal(left.orderKey, right.orderKey)
    || compareOrdinal(left.unitId, right.unitId);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
