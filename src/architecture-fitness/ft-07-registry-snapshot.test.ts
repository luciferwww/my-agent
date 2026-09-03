import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileTypeScriptFixture,
  findFt07MutableRegistryMembers,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-07', import.meta.url));

describe('FT-07 immutable Registry Snapshot boundary', () => {
  it('compiles a readonly Snapshot and rejects mutation and Builder injection', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt07MutableRegistryMembers(passSources, ['RegistrySnapshot'])).toEqual([]);
    expect(await compileTypeScriptFixture(`${FIXTURE_ROOT}/pass`)).toEqual([]);
    expect(findFt07MutableRegistryMembers(failSources, ['RegistryBuilder'])).toEqual([
      'FT-07 source=src/runtime/RuntimeApp.ts type=RegistryBuilder mutableMember=tools violation=mutable-registry-input',
    ]);
    expect(await compileTypeScriptFixture(`${FIXTURE_ROOT}/fail`)).toEqual([
      { code: 2339, file: 'src/runtime/RuntimeApp.ts' },
      { code: 2345, file: 'src/runtime/RuntimeApp.ts' },
    ]);
  });

  it('locks the three direct mutable members in the current RuntimeToolBundle', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt07MutableRegistryMembers(productionSources, ['RuntimeToolBundle'])).toEqual([
      'FT-07 source=src/runtime/types.ts type=RuntimeToolBundle mutableMember=llmDefinitions violation=mutable-registry-input',
      'FT-07 source=src/runtime/types.ts type=RuntimeToolBundle mutableMember=promptDefinitions violation=mutable-registry-input',
      'FT-07 source=src/runtime/types.ts type=RuntimeToolBundle mutableMember=tools violation=mutable-registry-input',
    ]);
  });
});
