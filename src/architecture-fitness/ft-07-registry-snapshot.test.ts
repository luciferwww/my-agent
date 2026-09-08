import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileTypeScriptFixture,
  findFt07MutableRegistryMembers,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';
import type { SourceInput } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-07', import.meta.url));
let productionSources: SourceInput[];

describe('FT-07 immutable Registry Snapshot boundary', () => {
  beforeAll(async () => {
    productionSources = await loadProductionSources(REPOSITORY_ROOT);
  });

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

  it('finds no mutable members in production Registry Snapshot projections', async () => {
    expect(findFt07MutableRegistryMembers(productionSources, [
      'RegistrySnapshot',
      'ToolProjection',
      'HookProjection',
    ])).toEqual([]);
  });

  it('finds no legacy Tool assembly, executor setter, or RuntimeApp Task post-assembly', async () => {
    const forbiddenEverywhere = [
      'setToolExecutor',
      'getDefaultBuiltinTools',
      'assembleRuntimeTools',
      'RuntimeToolBundle',
      'hookRegistrations',
      'createToolExecutor',
    ];
    const violations = productionSources.flatMap((source) => [
      ...forbiddenEverywhere
        .filter((symbol) => source.content.includes(symbol))
        .map((symbol) => `${source.path}: ${symbol}`),
      ...(source.path === 'src/runtime/RuntimeApp.ts'
        ? ['createTaskToolModule', 'buildRegistrySnapshot']
          .filter((symbol) => source.content.includes(symbol))
          .map((symbol) => `${source.path}: ${symbol}`)
        : []),
    ]);

    expect(violations).toEqual([]);
  });
});
