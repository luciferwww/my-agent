interface ResolvedModel {
  readonly id: string;
}

interface RegistrySnapshot {
  readonly generation: number;
}

export class AgentRunner {
  constructor(
    private readonly model: ResolvedModel,
    private readonly snapshot: RegistrySnapshot,
  ) {}
}
