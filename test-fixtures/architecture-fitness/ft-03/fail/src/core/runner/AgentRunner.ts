import { loadConfig as readConfig } from '../../platform/config/loader.js';

interface ToolCatalog {
  tools: string[];
}

export interface RunInput {
  readonly registry: ToolCatalog;
}

export class AgentRunner {
  constructor() {
    readConfig();
  }

  run(input: RunInput): void {
    input.registry.tools.push('mutable');
  }
}
