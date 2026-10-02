import { MAX_TOOL_EXECUTION_SLOTS } from '../../tools/execution.js';

export interface ToolExecutionSlotLease {
  release(): void;
}

export interface RuntimeQuarantineEntry {
  readonly executionId: string;
  readonly unitId: string;
  readonly slot: ToolExecutionSlotLease;
}

export class ToolExecutionRuntimeState {
  private occupiedSlots = 0;
  private readonly quarantined = new Map<string, RuntimeQuarantineEntry>();
  private readonly disabledUnitIds = new Set<string>();

  constructor(private readonly slotLimit = MAX_TOOL_EXECUTION_SLOTS) {
    if (!Number.isSafeInteger(slotLimit) || slotLimit < 1) {
      throw new TypeError('Tool execution slot limit must be a positive integer.');
    }
  }

  tryReserveSlot(): ToolExecutionSlotLease | null {
    if (this.occupiedSlots >= this.slotLimit) return null;
    this.occupiedSlots++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.occupiedSlots--;
      },
    };
  }

  isUnitDisabled(unitId: string): boolean {
    return this.disabledUnitIds.has(unitId);
  }

  disableUnit(unitId: string): void {
    this.disabledUnitIds.add(unitId);
  }

  moveToQuarantine(entry: RuntimeQuarantineEntry): void {
    if (this.quarantined.has(entry.executionId)) {
      throw new Error(`Execution "${entry.executionId}" is already quarantined.`);
    }
    this.quarantined.set(entry.executionId, entry);
    this.disableUnit(entry.unitId);
  }

  releaseQuarantine(executionId: string): boolean {
    const entry = this.quarantined.get(executionId);
    if (!entry) return false;
    this.quarantined.delete(executionId);
    entry.slot.release();
    return true;
  }

  get occupiedSlotCount(): number {
    return this.occupiedSlots;
  }

  get quarantineCount(): number {
    return this.quarantined.size;
  }
}

export const processToolExecutionRuntimeState = new ToolExecutionRuntimeState();
