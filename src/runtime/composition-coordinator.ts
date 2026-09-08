import type { RegistrySnapshot } from '../core/registry/index.js';

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
}

export class CompositionCoordinator {
  private currentSnapshot?: RegistrySnapshot;
  private closing = false;
  private readonly pinCounts = new Map<number, number>();

  get current(): RegistrySnapshot | undefined {
    return this.currentSnapshot;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  commitPublish(snapshot: RegistrySnapshot): PublishedGenerationChange {
    if (this.closing) {
      throw new Error('Runtime composition is closing.');
    }
    const previous = this.currentSnapshot;
    const expectedGeneration = previous ? previous.generation + 1 : 1;
    if (snapshot.generation !== expectedGeneration) {
      throw new Error(
        `Registry generation must be ${expectedGeneration}; received ${snapshot.generation}.`,
      );
    }
    this.currentSnapshot = snapshot;
    this.pinCounts.set(snapshot.generation, this.pinCounts.get(snapshot.generation) ?? 0);
    return Object.freeze({
      ...(previous ? { previous } : {}),
      current: snapshot,
    });
  }

  captureRootGeneration(): RuntimeGenerationPin {
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
        if (released) return;
        released = true;
        const count = this.pinCounts.get(generation);
        if (count === undefined || count < 1) {
          throw new Error(`Registry generation ${generation} pin accounting underflow.`);
        }
        this.pinCounts.set(generation, count - 1);
      },
    });
  }

  beginShutdown(): void {
    this.closing = true;
  }

  pinCount(generation: number): number {
    return this.pinCounts.get(generation) ?? 0;
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
}
