import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt06ChangeLocalityViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-06', import.meta.url));
const FIXTURE_MANIFEST = {
  identities: ['fixture-external-chat', 'fixture-provider'],
  corePaths: ['src/core/runner/', 'src/runtime/RuntimeApp.ts'],
};

describe('FT-06 Provider and Extension change locality', () => {
  it('accepts Contract-only registration and diagnoses a fixture-specific core branch', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt06ChangeLocalityViolations(passSources, FIXTURE_MANIFEST)).toEqual([]);
    expect(findFt06ChangeLocalityViolations(failSources, FIXTURE_MANIFEST)).toEqual([
      'FT-06 fixture=fixture-external-chat coreFile=src/runtime/RuntimeApp.ts matchedBranch=string-union',
      'FT-06 fixture=fixture-provider coreFile=src/core/runner/AgentRunner.ts matchedBranch=binary-expression',
    ]);
  });

  it('finds no synthetic fixture identity in current central production paths', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt06ChangeLocalityViolations(productionSources, FIXTURE_MANIFEST)).toEqual([]);
  });
});
