declare const snapshotBrand: unique symbol;

export interface RegistrySnapshot {
  readonly [snapshotBrand]: true;
  readonly tools: ReadonlyMap<string, { readonly name: string }>;
}

export class RegistryBuilder {
  readonly tools = new Map<string, { name: string }>();

  register(name: string): void {
    this.tools.set(name, { name });
  }
}

export class RuntimeApp {
  constructor(private readonly registry: RegistryBuilder) {}
}

declare const snapshot: RegistrySnapshot;
snapshot.tools.set('new-tool', { name: 'new-tool' });
new RuntimeApp(snapshot);
