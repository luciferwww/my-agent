import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectModuleReferences,
  loadProductionSources,
  loadTypeScriptSources,
  resolveRelativeModule,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-13 public module entry boundaries', () => {
  it('prevents cross-module deep imports and production imports of test fixtures', async () => {
    const sources = [
      ...await loadProductionSources(REPOSITORY_ROOT),
      ...await loadTypeScriptSources(join(REPOSITORY_ROOT, 'scripts'), [], 'scripts'),
    ];
    const publicRoots = [
      'src/builtins/providers/builtin',
      'src/builtins/channels/cli',
      'src/builtins/tools/environment',
      'src/builtins/tools/memory',
      'src/builtins/tools/task',
      'src/runtime/turn-interaction',
    ];
    const violations: string[] = [];
    for (const source of sources) {
      for (const reference of collectModuleReferences(source)) {
        const target = resolveRelativeModule(source.path, reference.specifier);
        if (!target) continue;
        for (const root of publicRoots) {
          if (!source.path.startsWith(`${root}/`)
            && target.startsWith(`${root}/`)
            && target !== `${root}/index.ts`) {
            violations.push(`${source.path}: deep import ${target}`);
          }
        }
        if (target.startsWith('test-fixtures/')
          || target.includes('/test-fixtures/')
          || target === 'src/core/tools/provider-portability-fixtures.ts') {
          violations.push(`${source.path}: test fixture import ${target}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
