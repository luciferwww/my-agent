import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProductionSources, loadTypeScriptSources } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-13 source layout convergence', () => {
  it('keeps builtin capabilities and Runtime interaction state in their canonical roots', async () => {
    const required = [
      'src/builtins/providers/builtin/AnthropicMessagesClient.ts',
      'src/builtins/providers/builtin/OpenAIResponsesClient.ts',
      'src/builtins/providers/builtin/OpenAIChatCompletionsClient.ts',
      'src/builtins/providers/builtin/BuiltinLlmProvider.ts',
      'src/builtins/providers/builtin/runtime-unit.ts',
      'src/builtins/providers/builtin/index.ts',
      'src/builtins/channels/cli/CliChannel.ts',
      'src/builtins/channels/cli/runtime-unit.ts',
      'extensions/websocket-channel/WebSocketChannel.ts',
      'extensions/websocket-channel/websocket-channel-unit.ts',
      'src/builtins/tools/environment/contribution.ts',
      'src/builtins/tools/environment/common/directory-walk.ts',
      'src/builtins/tools/memory/contribution.ts',
      'src/builtins/tools/task/contribution.ts',
      'src/runtime/turn-interaction/TurnInteractionManager.ts',
      'src/runtime/turn-interaction/index.ts',
      'src/extension/acquisition/index.ts',
      'src/extension/api/contracts.ts',
    ];
    for (const path of required) {
      await expect(stat(join(REPOSITORY_ROOT, ...path.split('/')))).resolves.toBeDefined();
    }

    const removed = [
      'src/runtime-modules',
      'src/adapters',
      'src/builtins/providers/anthropic',
      'src/core/tools/builtin',
      'src/core/memory/memory-tools.ts',
      'src/extensions/acquisition',
      'src/extension-acquisition',
      'src/extension-api',
      'src/builtins/tools/workspace',
      'src/builtins/tools/environment/common/working-directory-walk.ts',
      'src/builtins/channels/websocket',
      'clients/html/chat.html',
    ];
    for (const path of removed) {
      await expect(stat(join(REPOSITORY_ROOT, ...path.split('/')))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('keeps package entries explicit and named after their actual Runtime contracts', async () => {
    const [provider, cli, websocket, environment, memory, task] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'providers', 'builtin', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'channels', 'cli', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'extensions', 'websocket-channel', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'tools', 'environment', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'tools', 'memory', 'index.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'builtins', 'tools', 'task', 'index.ts'), 'utf8'),
    ]);

    expect(provider).toContain("export { AnthropicMessagesClient } from './AnthropicMessagesClient.js';");
    expect(provider).toContain('createBuiltinLlmProviderUnit');
    expect(cli).toContain("export { createCliChannelUnit } from './runtime-unit.js';");
    expect(websocket).toContain('createWebSocketChannelUnit');
    expect(environment).toContain("export { createEnvironmentContribution } from './contribution.js';");
    expect(memory).toContain("export { createMemoryToolsContribution } from './contribution.js';");
    expect(task).toContain("export { createTaskToolContribution } from './contribution.js';");
    expect(`${provider}\n${cli}\n${websocket}\n${environment}\n${memory}\n${task}`)
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
        'builtins/tools/workspace',
        'createWorkspaceToolsContribution',
        'WorkspaceToolsContributionOptions',
        'builtin-workspace-tools',
      ]) {
        if (source.content.includes(forbidden)) {
          diagnostics.push(`FT-13 source=${source.path} forbiddenPath=${forbidden}`);
        }
      }
      for (const capability of [
        'builtins/providers/builtin',
        'builtins/channels/cli',
        'builtins/tools/environment',
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
