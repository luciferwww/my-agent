import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt04LegacyDirectionViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-04', import.meta.url));
const FIXTURE_NEW_CORE_ROOTS = ['src/new-core/'];
const NEW_CORE_ROOTS = [
  'src/core/model-invocation/',
  'src/core/model-resolution/',
  'src/adapters/llm/AnthropicProvider.ts',
];
const FORBIDDEN_ROOTS = ['src/compat/', 'src/legacy/'];

describe('FT-04 Legacy dependency direction', () => {
  it('accepts Compat to New Core and diagnoses New Core to Legacy', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt04LegacyDirectionViolations(passSources, FIXTURE_NEW_CORE_ROOTS, FORBIDDEN_ROOTS)).toEqual([]);
    expect(findFt04LegacyDirectionViolations(failSources, FIXTURE_NEW_CORE_ROOTS, FORBIDDEN_ROOTS)).toEqual([
      'FT-04 source=src/new-core/ModelResolver.ts forbiddenTarget=src/legacy/llm-config-adapter.ts',
    ]);
  });

  it('prevents the Model Core and Provider module from depending on Compatibility', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt04LegacyDirectionViolations(productionSources, NEW_CORE_ROOTS, FORBIDDEN_ROOTS)).toEqual([]);
  });
});
