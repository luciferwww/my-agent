import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt05ExtensionCapabilityViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-05', import.meta.url));
const EXTENSION_ROOTS = ['src/extensions/', 'src/runtime-modules/'];

describe('FT-05 Extension capability boundary', () => {
  it('accepts declared capabilities and diagnoses RuntimeApp barrel and Service Locator access', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt05ExtensionCapabilityViolations(passSources, EXTENSION_ROOTS)).toEqual([]);
    expect(findFt05ExtensionCapabilityViolations(failSources, EXTENSION_ROOTS)).toEqual([
      'FT-05 source=src/extensions/acme/register.ts symbol=RuntimeApp capability=none violation=runtimeapp-import',
      'FT-05 source=src/extensions/acme/register.ts symbol=services.get capability=none violation=service-locator-get',
    ]);
  });

  it('keeps production Runtime Modules inside declared capability boundaries', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt05ExtensionCapabilityViolations(productionSources, EXTENSION_ROOTS)).toEqual([]);
  });

  it('keeps builtin concrete Channel construction out of RuntimeApp and removes legacy lifecycle APIs', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);
    const concreteConstructionPaths = productionSources
      .filter((source) => /\bnew\s+(?:CliChannel|WebSocketChannel)\s*\(/.test(source.content))
      .map((source) => source.path)
      .sort();
    const runtimeApp = productionSources.find((source) => source.path === 'src/runtime/RuntimeApp.ts');

    expect(concreteConstructionPaths).toEqual(['src/runtime-modules/builtin-channels.ts']);
    expect(runtimeApp).toBeDefined();
    expect(runtimeApp?.content).not.toMatch(/\b(?:registerChannel|startChannels|stopChannels)\s*\(/);
  });
});
