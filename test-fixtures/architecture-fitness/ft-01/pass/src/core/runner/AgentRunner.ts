import type { ResolvedModel } from './ports/model.js';

export interface RunnerInput {
  readonly model: ResolvedModel;
}
