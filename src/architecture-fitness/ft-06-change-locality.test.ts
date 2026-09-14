import { readFile } from 'node:fs/promises';
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

  it('keeps the supported Host on generic acquisition without Extension-specific authority', async () => {
    const host = await readFile(`${REPOSITORY_ROOT}/scripts/server.ts`, 'utf8');
    const startup = await readFile(
      `${REPOSITORY_ROOT}/scripts/websocket-host-startup.ts`,
      'utf8',
    );

    expect(host).toContain('prepareWebSocketHostAcquisition(');
    expect(host).toContain('...acquisition.result.loadedUnits');
    expect(host).toContain('const envOverrides = getEnvOverrides();');
    expect(host).toContain('...envOverrides');
    expect(host.indexOf('const envOverrides = getEnvOverrides();'))
      .toBeLessThan(host.indexOf('prepareWebSocketHostAcquisition('));
    expect(host).toContain('createWebSocketChannelModule({');
    expect(`${host}\n${startup}`)
      .not.toMatch(/copilot-relay-provider|COPILOT_RELAY_|createCopilotRelayProviderUnit/);
    expect(host).not.toMatch(/providerId\s*:\s*['"][^'"]+['"]/);
    expect(host).not.toMatch(/catch[\s\S]{0,200}create.*ProviderUnit/u);
  });

  it('guards the current direct acquisition, lifecycle, configuration, and error authorities', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);
    const loader = productionSources.find(
      ({ path }) => path === 'src/extensions/acquisition/loader.ts',
    )?.content;
    const runtimeSources = productionSources.filter(
      ({ path }) => path.startsWith('src/runtime/'),
    );
    const relayClient = productionSources.find(
      ({ path }) => path === 'src/extensions/copilot-relay-provider/responses-client.ts',
    )?.content;

    expect(loader).toBeDefined();
    expect(relayClient).toBeDefined();
    expect(loader).toContain('if (enabled === undefined || enabled === false)');
    expect(loader).toContain('if (enabled !== true');
    expect(loader).not.toMatch(/\b(?:unit\.)?(?:create|start|stop)\s*\(/u);
    expect(loader).not.toMatch(/\b(?:registerProvider|stageRegistryUnit)\s*\(/u);
    expect(runtimeSources.every(({ content }) =>
      !content.includes('extensions/acquisition')
      && !content.includes('copilot-relay-provider'))).toBe(true);
    expect(relayClient).not.toMatch(/from ['"][^'"]*runtime[^'"]*['"]/u);
    expect(relayClient).not.toMatch(/import\s*\{[^}]*\bModelInvocationError\b[^}]*\}/u);

    const relaySpecificOutsideExtension = productionSources
      .filter(({ path }) => !path.startsWith('src/extensions/copilot-relay-provider/'))
      .filter(({ content }) =>
        /COPILOT_RELAY_|createCopilotRelayProviderUnit/u.test(content))
      .map(({ path }) => path);
    expect(relaySpecificOutsideExtension).toEqual([]);
  });
});
