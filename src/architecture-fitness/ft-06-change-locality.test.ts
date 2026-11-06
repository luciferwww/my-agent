import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectModuleReferences, loadProductionSources, resolveRelativeModule } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-06 concrete Extension dependency boundary', () => {
  it('keeps Host, Runtime, and acquisition independent of concrete Extension modules', async () => {
    const sources = await loadProductionSources(REPOSITORY_ROOT);
    const violations = sources
      .filter(({ path }) => path.startsWith('src/hosts/')
        || path.startsWith('src/runtime/')
        || path.startsWith('src/extension/acquisition/'))
      .flatMap((source) => collectModuleReferences(source)
        .filter(({ specifier }) => resolveRelativeModule(source.path, specifier)?.startsWith('extensions/'))
        .map(({ specifier }) => `${source.path}: ${specifier}`));

    expect(violations).toEqual([]);
  });
});
