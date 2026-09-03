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
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../runtime/bootstrap.js target=src/runtime/bootstrap.ts targetBoundary=Composition',
    ]);
  });

  it('locks the exact current production violations and path classification', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findUnclassifiedProductionFiles(productionSources)).toEqual([]);
    expect(findFt01MixedInventoryDrift(productionSources)).toEqual([]);
    expect(findFt01MixedInventoryDrift(
      productionSources.filter((source) => source.path !== 'src/runtime/errors.ts'),
    )).toContain('FT-01 inventory=missing path=src/runtime/errors.ts');
    expect(findFt01BoundaryViolations(productionSources)).toEqual([
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
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../platform/config/types.js target=src/platform/config/types.ts targetBoundary=Composition',
      'FT-01 source=src/core/runner/AgentRunner.ts boundary=Application import=../../platform/logger/index.js target=src/platform/logger/index.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/context/compaction.ts boundary=Application import=../../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/context/compaction.ts boundary=Application import=../../../platform/config/types.js target=src/platform/config/types.ts targetBoundary=Composition',
      'FT-01 source=src/core/runner/context/context-budget.ts boundary=Application import=../../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/context/context-budget.ts boundary=Application import=../../../platform/config/types.js target=src/platform/config/types.ts targetBoundary=Composition',
      'FT-01 source=src/core/runner/context/token-estimation.ts boundary=Application import=../../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/context/tool-result-pruning.ts boundary=Application import=../../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/context/tool-result-pruning.ts boundary=Application import=../../../platform/config/types.js target=src/platform/config/types.ts targetBoundary=Composition',
      'FT-01 source=src/core/runner/hooks/runner.ts boundary=Application import=../../../platform/logger/index.js target=src/platform/logger/index.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/types.ts boundary=Application import=../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/runner/types.ts boundary=Application import=../../platform/config/types.js target=src/platform/config/types.ts targetBoundary=Composition',
      'FT-01 source=src/core/subagent/SubagentRunner.ts boundary=Application import=../../platform/logger/index.js target=src/platform/logger/index.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/subagent/config-loader.ts boundary=Application import=../../platform/config/types.js target=src/platform/config/types.ts targetBoundary=Composition',
      'FT-01 source=src/core/subagent/types.ts boundary=Application import=../../adapters/llm/types.js target=src/adapters/llm/types.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/tools/index.ts boundary=Domain/Application import=./builtin/common/path-policy.js target=src/core/tools/builtin/common/path-policy.ts targetBoundary=Infrastructure',
      'FT-01 source=src/core/tools/index.ts boundary=Domain/Application import=./builtin/index.js target=src/core/tools/builtin/index.ts targetBoundary=Infrastructure',
    ]);
  });
});
