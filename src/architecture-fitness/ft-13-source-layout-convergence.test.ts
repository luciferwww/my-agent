import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProductionSources, loadTypeScriptSources } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-13 source layout convergence', () => {
  it('keeps Anthropic, Channel, and Turn Interaction in their canonical module roots', async () => {
    const required = [
      'src/adapters/provider/anthropic/AnthropicClient.ts',
      'src/adapters/provider/anthropic/AnthropicProvider.ts',
      'src/adapters/provider/anthropic/tool-codec.ts',
      'src/adapters/provider/anthropic/index.ts',
      'src/runtime/turn-interaction/TurnInteractionManager.ts',
      'src/runtime/turn-interaction/index.ts',
      'src/runtime-modules/anthropic-provider.ts',
      'src/runtime-modules/anthropic-provider.test.ts',
    ];
    for (const path of required) {
      await expect(stat(join(REPOSITORY_ROOT, ...path.split('/')))).resolves.toBeDefined();
    }

    const removed = [
      'src/adapters/llm/index.ts',
      'src/adapters/llm/AnthropicClient.ts',
      'src/adapters/llm/AnthropicProvider.ts',
      'src/adapters/llm/tool-contract-codecs.ts',
      'src/adapters/channel/types.ts',
      'src/adapters/channel/TurnInteractionManager.ts',
      'src/adapters/provider/index.ts',
    ];
    for (const path of removed) {
      await expect(stat(join(REPOSITORY_ROOT, ...path.split('/')))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('keeps the Channel barrel limited to concrete transport adapters', async () => {
    const barrel = await readFile(
      join(REPOSITORY_ROOT, 'src', 'adapters', 'channel', 'index.ts'),
      'utf8',
    );
    expect(barrel.trim().split(/\r?\n/u)).toEqual([
      "export { CliChannel, type CliChannelConfig } from './CliChannel.js';",
      "export { WebSocketChannel, type WebSocketChannelConfig } from './WebSocketChannel.js';",
    ]);
    expect(barrel).not.toMatch(/ApprovalManager|TurnInteractionManager|core\/channel|\.\/types/u);
  });

  it('exports the Anthropic Provider factory without exposing Adapter internals', async () => {
    const barrel = await readFile(
      join(REPOSITORY_ROOT, 'src', 'runtime-modules', 'index.ts'),
      'utf8',
    );
    expect(barrel).toContain(
      "export { createAnthropicProviderModule } from './anthropic-provider.js';",
    );
    expect(barrel).not.toMatch(/\b(?:AnthropicProvider|AnthropicClient)\b/u);
  });

  it('rejects old paths, deep external module imports, and test fixtures in production or scripts', async () => {
    const production = await loadProductionSources(REPOSITORY_ROOT);
    const scripts = await loadTypeScriptSources(
      join(REPOSITORY_ROOT, 'scripts'),
      [],
      'scripts',
    );
    const diagnostics: string[] = [];

    for (const source of [...production, ...scripts]) {
      for (const forbidden of [
        'adapters/llm',
        'adapters/channel/types',
        'adapters/channel/TurnInteractionManager',
      ]) {
        if (source.content.includes(forbidden)) {
          diagnostics.push(`FT-13 source=${source.path} forbiddenPath=${forbidden}`);
        }
      }
      if (
        !source.path.startsWith('src/adapters/provider/anthropic/')
        && /adapters\/provider\/anthropic\/(?!index\.js)/u.test(source.content)
      ) {
        diagnostics.push(`FT-13 source=${source.path} violation=anthropic-deep-import`);
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