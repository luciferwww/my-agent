import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt01BoundaryViolations,
  findFt01MixedInventoryDrift,
  findUnclassifiedProductionFiles,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-01', import.meta.url));

describe('FT-01 stable core boundaries', () => {
  it('accepts a core-owned port and diagnoses an Application to Composition edge', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt01BoundaryViolations(passSources)).toEqual([]);
    expect(findFt01BoundaryViolations(failSources)).toEqual([
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../runtime/composition/bootstrap.js target=src/runtime/composition/bootstrap.ts targetBoundary=Composition',
    ]);
  });

  it('rejects stable-core imports of definition loading and Agent policy composition', () => {
    const sources = [{
      path: 'src/core/runner/AgentRunner.ts',
      content: [
        "import { loadAgentDefinitions } from '../agent-context/agent-definitions.js';",
        "import { AgentPolicyState } from '../../runtime/policy/agent-policy-state.js';",
        "import { loadSkill } from '../skills/library.js';",
      ].join('\n'),
    }];
    expect(findUnclassifiedProductionFiles([
      { path: 'src/core/agent-context/agent-definitions.ts', content: '' },
      { path: 'src/runtime/policy/agent-policy-state.ts', content: '' },
      { path: 'src/core/skills/config.ts', content: '' },
      { path: 'src/core/skills/types.ts', content: '' },
      { path: 'src/core/skills/library.ts', content: '' },
      { path: 'src/core/skills/index.ts', content: '' },
    ])).toEqual([]);
    expect(findFt01BoundaryViolations(sources)).toEqual([
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../runtime/policy/agent-policy-state.js target=src/runtime/policy/agent-policy-state.ts targetBoundary=Composition',
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../agent-context/agent-definitions.js target=src/core/agent-context/agent-definitions.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../skills/library.js target=src/core/skills/library.ts targetBoundary=Infrastructure',
    ]);
  });

  it('rejects new production violations and unclassified paths', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findUnclassifiedProductionFiles(productionSources)).toEqual([]);
    expect(findFt01MixedInventoryDrift(productionSources)).toEqual([]);
    expect(findFt01MixedInventoryDrift(
      productionSources.filter((source) => source.path !== 'src/runtime/errors.ts'),
    )).toContain('FT-01 inventory=missing path=src/runtime/errors.ts');
    const allowedViolations = new Set([
      'FT-01 source=src/core/memory/MemoryManager.ts boundary=Application import=../../platform/logger/index.js target=src/platform/logger/index.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/MemoryManager.ts boundary=Application import=./internal/LocalEmbeddingProvider.js target=src/core/memory/internal/LocalEmbeddingProvider.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/MemoryManager.ts boundary=Application import=./internal/MemoryIndexer.js target=src/core/memory/internal/MemoryIndexer.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/MemoryManager.ts boundary=Application import=./internal/MemorySearcher.js target=src/core/memory/internal/MemorySearcher.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/MemoryManager.ts boundary=Application import=./internal/RecallTracker.js target=src/core/memory/internal/RecallTracker.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/MemoryManager.ts boundary=Application import=./internal/sqlite-store.js target=src/core/memory/internal/sqlite-store.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/index.ts boundary=Application import=./internal/LocalEmbeddingProvider.js target=src/core/memory/internal/LocalEmbeddingProvider.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/index.ts boundary=Application import=./internal/MemoryIndexer.js target=src/core/memory/internal/MemoryIndexer.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/index.ts boundary=Application import=./internal/MemorySearcher.js target=src/core/memory/internal/MemorySearcher.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/index.ts boundary=Application import=./internal/RecallTracker.js target=src/core/memory/internal/RecallTracker.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/memory/index.ts boundary=Application import=./internal/sqlite-store.js target=src/core/memory/internal/sqlite-store.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../platform/logger/index.js target=src/platform/logger/index.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/hooks/runner.ts boundary=Application import=../../../platform/logger/index.js target=src/platform/logger/index.ts targetBoundary=Infrastructure',
    ]);
    expect(findFt01BoundaryViolations(productionSources)
      .filter((violation) => !allowedViolations.has(violation))).toEqual([]);
  });
});
