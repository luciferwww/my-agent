import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectModuleReferences, loadProductionSources, resolveRelativeModule } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-14 module-owned configuration boundary', () => {
  it('prevents leaf modules from depending on Platform Configuration', async () => {
    const sources = await loadProductionSources(REPOSITORY_ROOT);
    const leafRoots = [
      'src/core/memory/',
      'src/core/prompt/',
      'src/core/tools/',
      'src/core/agent-context/',
      'src/core/runner/',
      'src/core/subagent/',
      'src/platform/logger/',
    ];
    const violations = sources
      .filter(({ path }) => leafRoots.some((root) => path.startsWith(root)))
      .flatMap((source) => collectModuleReferences(source)
        .filter(({ specifier }) => resolveRelativeModule(source.path, specifier)?.startsWith('src/platform/config/'))
        .map(({ specifier }) => `${source.path}: ${specifier}`));

    expect(violations).toEqual([]);
  });
});
