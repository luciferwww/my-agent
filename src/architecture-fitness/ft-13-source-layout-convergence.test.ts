import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProductionSources, loadTypeScriptSources } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-13 source layout convergence', () => {
  it('keeps builtin capabilities and Runtime interaction state in their canonical roots', async () => {
    const required = [
      'src/builtins/providers/anthropic/AnthropicMessagesClient.ts',
      'src/builtins/providers/anthropic/AnthropicCompatibleProvider.ts',
      'src/builtins/providers/anthropic/tool-codec.ts',
      'src/builtins/providers/anthropic/runtime-unit.ts',
      'src/builtins/providers/anthropic/index.ts',
      'src/builtins/channels/cli/CliChannel.ts',
      'src/builtins/channels/cli/runtime-unit.ts',
      'src/builtins/channels/websocket/WebSocketChannel.ts',
      'src/builtins/channels/websocket/runtime-unit.ts',
      'src/builtins/tools/workspace/contribution.ts',
      'src/builtins/tools/memory/contribution.ts',
      'src/builtins/tools/task/contribution.ts',
      'src/runtime/turn-interaction/TurnInteractionManager.ts',
      'src/runtime/turn-interaction/index.ts',
      'src/extension-acquisition/index.ts',
      'src/extension-acquisition/contracts.ts',
    ];
    for (const path of required) {
      await expect(stat(join(REPOSITORY_ROOT, ...path.split('/')))).resolves.toBeDefined();
    }

    const removed = [
      'src/runtime-modules',
      'src/adapters',
      'src/core/tools/builtin',
      'src/core/memory/memory-tools.ts',
      'src/extensions/acquisition',
    ];
    for (const path of removed) {
      await expect(stat(join(REPOSITORY_ROOT, ...path.split('/')))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('keeps package entries explicit and named after their actual Runtime contracts', async () => {
    const [provider, cli, websocket, workspace, memory, task] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'providers', 'anthropic', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'channels', 'cli', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'channels', 'websocket', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'tools', 'workspace', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'tools', 'memory', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'tools', 'task', 'index.ts'), 'utf8'),
    ]);

    expect(provider).toContain("export { AnthropicMessagesClient } from './AnthropicMessagesClient.js';");
    expect(provider).toContain('createAnthropicProviderUnit');
    expect(cli).toContain("export { createCliChannelUnit } from './runtime-unit.js';");
    expect(websocket).toContain("export { createWebSocketChannelUnit } from './runtime-unit.js';");
    expect(workspace).toContain("export { createWorkspaceToolsContribution } from './contribution.js';");
    expect(memory).toContain("export { createMemoryToolsContribution } from './contribution.js';");
    expect(task).toContain("export { createTaskToolContribution } from './contribution.js';");
    expect(`${provider}\n${cli}\n${websocket}\n${workspace}\n${memory}\n${task}`)
      .not.toMatch(/export \*|create\w+Module|AnthropicClient\b|AnthropicProvider\b/u);
  });

  it('rejects old paths, external deep capability imports, and test fixtures in production or scripts', async () => {
    const production = await loadProductionSources(REPOSITORY_ROOT);
    const scripts = await loadTypeScriptSources(join(REPOSITORY_ROOT, 'scripts'), [], 'scripts');
    const diagnostics: string[] = [];

    for (const source of [...production, ...scripts]) {
      for (const forbidden of [
        'runtime-modules',
        'adapters/provider/anthropic',
        'adapters/channel',
        'core/tools/builtin',
        'core/memory/memory-tools',
        'extensions/acquisition',
      ]) {
        if (source.content.includes(forbidden)) {
          diagnostics.push(`FT-13 source=${source.path} forbiddenPath=${forbidden}`);
        }
      }
      for (const capability of [
        'builtins/providers/anthropic',
        'builtins/channels/cli',
        'builtins/channels/websocket',
        'builtins/tools/workspace',
        'builtins/tools/memory',
        'builtins/tools/task',
      ]) {
        if (
          !source.path.startsWith(`src/${capability}/`)
          && new RegExp(`${capability}/(?!index\\.js)`, 'u').test(source.content)
        ) {
          diagnostics.push(`FT-13 source=${source.path} capability=${capability} violation=deep-import`);
        }
      }
      if (
        !source.path.startsWith('src/runtime/turn-interaction/')
        && /runtime\/turn-interaction\/(?!index\.js)/u.test(source.content)
      ) {
        diagnostics.push(`FT-13 source=${source.path} violation=turn-interaction-deep-import`);
      }
      if (
        source.path !== 'src/core/tools/provider-portability-fixtures.ts'
        && source.content.includes('provider-portability-fixtures')
      ) {
        diagnostics.push(`FT-13 source=${source.path} violation=test-fixture-import`);
      }
    }

    expect(diagnostics).toEqual([]);
  });
});
