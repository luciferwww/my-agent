import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt08ContractInventoryViolations,
  loadTypeScriptSources,
} from './rules.js';
import type { ContractInventoryEntry, ContractSurfaceEntry } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-08', import.meta.url));
const SURFACE_PATH = fileURLToPath(new URL('./ft-08-contract-surface.json', import.meta.url));
const INVENTORY_PATH = fileURLToPath(new URL('./ft-08-contract-inventory.json', import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('FT-08 Contract Test inventory', () => {
  it('accepts complete coverage and diagnoses missing inventory and negative coverage', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);
    const passInventory = await readJson<ContractInventoryEntry[]>(`${FIXTURE_ROOT}/pass/contract-inventory.json`);
    const failInventory = await readJson<ContractInventoryEntry[]>(`${FIXTURE_ROOT}/fail/contract-inventory.json`);

    expect(findFt08ContractInventoryViolations(
      passSources,
      [{ contract: 'FixtureLifecycle', source: 'src/contracts.ts', kind: 'lifecycle' }],
      passInventory,
      new Set(['src/contracts.positive.test.ts', 'src/contracts.negative.test.ts']),
    )).toEqual([]);
    expect(findFt08ContractInventoryViolations(
      failSources,
      [
        { contract: 'MissingLifecycle', source: 'src/contracts.ts', kind: 'lifecycle' },
        { contract: 'UncoveredPort', source: 'src/contracts.ts', kind: 'port' },
      ],
      failInventory,
      new Set(['src/contracts.positive.test.ts']),
    )).toEqual([
      'FT-08 contract=MissingLifecycle source=src/contracts.ts kind=lifecycle violation=missing-inventory-entry',
      'FT-08 contract=PayloadConfig source=src/contracts.ts kind=config violation=inventory-outside-surface',
      'FT-08 contract=UncoveredPort source=src/contracts.ts kind=port violation=missing-negative-coverage',
    ]);
  });

  it('locks the reviewed public Contract surface and current coverage gaps', async () => {
    const allSources = await loadTypeScriptSources(`${REPOSITORY_ROOT}/src`, [
      'src/architecture-fitness/',
      'src/test-setup.ts',
    ], 'src');
    const productionSources = allSources.filter((source) => !source.path.endsWith('.test.ts'));
    const availableTestPaths = new Set(
      allSources.filter((source) => source.path.endsWith('.test.ts')).map((source) => source.path),
    );
    const surface = await readJson<ContractSurfaceEntry[]>(SURFACE_PATH);
    const inventory = await readJson<ContractInventoryEntry[]>(INVENTORY_PATH);

    expect(findFt08ContractInventoryViolations(
      productionSources,
      surface,
      inventory,
      availableTestPaths,
    )).toEqual([
      'FT-08 contract=LogAdapter source=src/platform/logger/types.ts kind=adapter-port-lifecycle violation=missing-negative-coverage',
      'FT-08 contract=MemoryStore source=src/core/memory/types.ts kind=store-port-lifecycle violation=missing-negative-coverage',
    ]);
  });
});
