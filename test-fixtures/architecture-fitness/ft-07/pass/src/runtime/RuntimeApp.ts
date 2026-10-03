export interface RegistrySnapshot {
  readonly tools: ReadonlyMap<string, { readonly name: string }>;
}

export class RuntimeApp {
  constructor(private readonly snapshot: RegistrySnapshot) {}

  getTool(name: string): { readonly name: string } | undefined {
    return this.snapshot.tools.get(name);
  }
}
