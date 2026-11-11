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
      'src/runtime/settings',
      'src/core/settings',
    ];
    const violations: string[] = [];
    for (const source of sources) {
      for (const reference of collectModuleReferences(source)) {
        const target = resolveRelativeModule(source.path, reference.specifier);
        if (!target) continue;
        if (source.path.startsWith('src/core/settings/')
          && /^(?:src\/(?:runtime|platform|builtins|extension|hosts|core\/channel)\/|extensions\/)/u.test(target)) {
          violations.push(`${source.path}: Settings contract depends on ${target}`);
        }
        if (source.path.startsWith('src/runtime/settings/')
          && source.path !== 'src/runtime/settings/index.ts'
          && target === 'src/runtime/settings/settings-manager.ts') {
          violations.push(`${source.path}: Settings implementation depends on SettingsManager`);
        }
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
