import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt02SdkAllowlistViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-02', import.meta.url));

describe('FT-02 integration SDK allowlist', () => {
  it('accepts an Adapter SDK import and diagnoses the same import in Runtime', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt02SdkAllowlistViolations(passSources)).toEqual([]);
    expect(findFt02SdkAllowlistViolations(failSources)).toEqual([
      'FT-02 package=@anthropic-ai/sdk source=src/runtime/RuntimeApp.ts allowedRoots=src/adapters/llm/**',
    ]);
  });

  it('keeps Provider and Channel SDK imports inside current Adapter roots', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt02SdkAllowlistViolations(productionSources)).toEqual([]);
  });
});
