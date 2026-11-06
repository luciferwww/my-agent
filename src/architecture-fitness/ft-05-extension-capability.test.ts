import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt05ExtensionCapabilityViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-05', import.meta.url));
const EXTENSION_ROOTS = ['extensions/', 'src/extensions/', 'src/builtins/'];

describe('FT-05 Extension capability boundary', () => {
  it('accepts declared capabilities and diagnoses RuntimeApp access through a barrel', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt05ExtensionCapabilityViolations(passSources, EXTENSION_ROOTS)).toEqual([]);
    expect(findFt05ExtensionCapabilityViolations(failSources, EXTENSION_ROOTS)).toEqual([
      'FT-05 source=src/extensions/acme/register.ts symbol=RuntimeApp capability=none violation=runtimeapp-import',
    ]);
  });

  it('keeps production capability packages inside declared capability boundaries', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);
    expect(findFt05ExtensionCapabilityViolations(productionSources, EXTENSION_ROOTS)).toEqual([]);
  });
});
