import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt03RunnerBoundaryViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-03', import.meta.url));

describe('FT-03 Runner input boundary', () => {
  it('accepts explicit Turn inputs and diagnoses Config loader and mutable Registry access', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt03RunnerBoundaryViolations(passSources)).toEqual([]);
    expect(findFt03RunnerBoundaryViolations(failSources)).toEqual([
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=ToolCatalog violation=mutable-registry-input',
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=loadConfig violation=config-loader-import',
    ]);
  });

  it('locks the exact current Runner coupling baseline', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt03RunnerBoundaryViolations(productionSources)).toEqual([
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=CompactionConfig violation=config-import',
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=Logger violation=global-service-import',
      'FT-03 source=src/core/runner/context/compaction.ts symbol=CompactionConfig violation=config-import',
      'FT-03 source=src/core/runner/context/context-budget.ts symbol=CompactionConfig violation=config-import',
      'FT-03 source=src/core/runner/context/tool-result-pruning.ts symbol=CompactionConfig violation=config-import',
      'FT-03 source=src/core/runner/hooks/runner.ts symbol=Logger violation=global-service-import',
      'FT-03 source=src/core/runner/types.ts symbol=CompactionConfig violation=config-import',
    ]);
  });
});
