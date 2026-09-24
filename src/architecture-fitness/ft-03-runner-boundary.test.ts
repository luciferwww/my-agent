import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt03RunnerBoundaryViolations,
  loadProductionSources,
  loadTypeScriptSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-03', import.meta.url));

describe('FT-03 Runner input boundary', () => {
  it('accepts explicit Turn inputs and diagnoses Config loader and mutable Registry access', async () => {
    const passSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/pass`);
    const failSources = await loadTypeScriptSources(`${FIXTURE_ROOT}/fail`);

    expect(findFt03RunnerBoundaryViolations(passSources)).toEqual([]);
    expect(findFt03RunnerBoundaryViolations(failSources)).toEqual([
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=ToolCatalog violation=mutable-registry-input',
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=loadConfig violation=config-loader-import',
    ]);
  });

  it('locks the exact current Runner coupling baseline', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt03RunnerBoundaryViolations(productionSources)).toEqual([
      'FT-03 source=src/core/runner/AgentRunner.ts symbol=Logger violation=global-service-import',
      'FT-03 source=src/core/runner/hooks/runner.ts symbol=Logger violation=global-service-import',
    ]);
  });

  it('keeps Runtime and Runner leaf configuration owned by their modules', async () => {
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);
    const [platformTypes, defaultComposition, configLoader, runtimeConfig, runnerConfig, runner] =
      await Promise.all([
        readFile(join(REPOSITORY_ROOT, 'src', 'platform', 'config', 'types.ts'), 'utf8'),
        readFile(join(REPOSITORY_ROOT, 'src', 'platform', 'config', 'default-composition.ts'), 'utf8'),
        readFile(join(REPOSITORY_ROOT, 'src', 'platform', 'config', 'agent-config-loader.ts'), 'utf8'),
        readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'config.ts'), 'utf8'),
        readFile(join(REPOSITORY_ROOT, 'src', 'core', 'runner', 'config.ts'), 'utf8'),
        readFile(join(REPOSITORY_ROOT, 'src', 'core', 'runner', 'AgentRunner.ts'), 'utf8'),
      ]);

    expect(platformTypes).not.toMatch(/interface\s+(?:RuntimeConfig|RunnerConfig)\b/u);
    const agentDefaults = platformTypes.match(
      /export interface AgentDefaults\s*\{(?<body>[\s\S]*?)\n\}/u,
    )?.groups?.['body'] ?? '';
    expect(agentDefaults).not.toMatch(/\b(?:runtime|runner)\s*:/u);
    expect(defaultComposition).not.toContain('DEFAULT_RUNTIME_CONFIG');
    expect(defaultComposition).not.toContain('DEFAULT_RUNNER_CONFIG');
    expect(defaultComposition).not.toContain('maxLlmCalls: 12');
    expect(configLoader).toContain('runtime: document.runtime');
    expect(configLoader).toContain('runner: document.runner');
    expect(configLoader).toContain("rejectGlobalPolicyConfig(value.defaults, 'agents.defaults')");
    expect(runtimeConfig).toContain('export interface RuntimeConfig');
    expect(runtimeConfig).toContain('steeringEnabled: false');
    expect(runnerConfig).toContain('export interface RunnerConfig');
    expect(runnerConfig).toContain('readonly maxLlmCalls?: number');
    expect(runner).not.toContain('DEFAULT_MAX_LLM_CALLS');
    expect(
      productionSources.filter((source) => source.content.includes('inTurnMessageMode')),
    ).toEqual([]);
  });
});
