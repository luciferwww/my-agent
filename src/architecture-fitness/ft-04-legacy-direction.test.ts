import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findFt04LegacyDirectionViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';
import type { SourceInput } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-04', import.meta.url));
const FIXTURE_NEW_CORE_ROOTS = ['src/new-core/'];
const NEW_CORE_ROOTS = [
  'src/core/model-invocation/',
  'src/core/model-resolution/',
  'src/core/subagent/',
  'src/runtime/subagent-orchestration.ts',
  'src/adapters/llm/AnthropicProvider.ts',
];
const FORBIDDEN_ROOTS = ['src/compat/', 'src/legacy/'];
let productionSources: SourceInput[];

describe('FT-04 Legacy dependency direction', () => {
  beforeAll(async () => {
    productionSources = await loadProductionSources(REPOSITORY_ROOT);
  });

  it('accepts Compat to New Core and diagnoses New Core to Legacy', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt04LegacyDirectionViolations(passSources, FIXTURE_NEW_CORE_ROOTS, FORBIDDEN_ROOTS)).toEqual([]);
    expect(findFt04LegacyDirectionViolations(failSources, FIXTURE_NEW_CORE_ROOTS, FORBIDDEN_ROOTS)).toEqual([
      'FT-04 source=src/new-core/ModelResolver.ts forbiddenTarget=src/legacy/llm-config-adapter.ts',
    ]);
  });

  it('prevents the Model Core and Provider module from depending on Compatibility', async () => {
    expect(findFt04LegacyDirectionViolations(productionSources, NEW_CORE_ROOTS, FORBIDDEN_ROOTS)).toEqual([]);
  });

  it('locks CODE-M09 deleted contracts out of production and scripts', async () => {
    const scriptSources = await loadTypeScriptSources(`${REPOSITORY_ROOT}/scripts`, [], 'scripts');
    const deletedSymbols = [
      'runSubagentTurn',
      'resolveLegacyChildModel',
      'createLegacyChildModelResolver',
      'SubagentHostBindings',
      'SubagentRunner',
      'SubagentRunnerDeps',
      'SubagentRunRequest',
      'SubagentRunInput',
      'RunTrigger',
      'subagentRunner',
      'isSynthetic',
      'legacy-child',
    ];
    const violations = [...productionSources, ...scriptSources].flatMap((source) =>
      deletedSymbols
        .filter((symbol) => source.content.includes(symbol))
        .map((symbol) => `FT-04 source=${source.path} deletedContract=${symbol}`),
    );

    expect(violations).toEqual([]);
  });
});
