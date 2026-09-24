import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProductionSources } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-14 module-owned Agent configuration', () => {
  it('keeps leaf contracts and defaults out of Platform Configuration', async () => {
    await expect(stat(join(REPOSITORY_ROOT, 'src', 'platform', 'config', 'defaults.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const types = await readFile(
      join(REPOSITORY_ROOT, 'src', 'platform', 'config', 'types.ts'),
      'utf8',
    );
    for (const leaf of [
      'MemoryConfig',
      'PromptConfig',
      'ToolPolicyConfig',
      'AgentContextConfig',
      'CompactionConfig',
      'SubagentConfig',
      'LoggerConfig',
    ]) {
      expect(types).not.toMatch(new RegExp(`interface\\s+${leaf}\\b`, 'u'));
    }

    const composition = await readFile(
      join(REPOSITORY_ROOT, 'src', 'platform', 'config', 'default-composition.ts'),
      'utf8',
    );
    expect(composition).not.toMatch(/1600|20_000|150_000|safetyLevel:\s*['"]normal/u);
  });

  it('prevents leaf modules from depending on Platform Configuration', async () => {
    const production = await loadProductionSources(REPOSITORY_ROOT);
    const diagnostics = production
      .filter((source) =>
        (
          source.path.startsWith('src/core/memory/')
          || source.path.startsWith('src/core/prompt/')
          || source.path.startsWith('src/core/tools/')
          || source.path.startsWith('src/core/agent-context/')
          || source.path.startsWith('src/core/runner/')
          || source.path.startsWith('src/core/subagent/')
          || source.path.startsWith('src/platform/logger/')
        )
        && /platform\/config/u.test(source.content),
      )
      .map((source) => `FT-14 source=${source.path} violation=platform-config-import`);

    expect(diagnostics).toEqual([]);
  });

  it('keeps Memory chunking wired through Runtime and behaviorally covered', async () => {
    const [bootstrap, runtimeTypes, indexer, indexerTest] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'bootstrap.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'types.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'core', 'memory', 'internal', 'MemoryIndexer.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'core', 'memory', 'internal', 'MemoryIndexer.test.ts'), 'utf8'),
    ]);

    expect(bootstrap).toContain('chunking: resolvedConfig.memory.chunking');
    expect(runtimeTypes).toContain("chunking?: AgentDefaults['memory']['chunking']");
    expect(indexer).toContain('this.chunking.chunkChars');
    expect(indexer).toContain('this.chunking.overlapChars');
    expect(indexerTest).toContain('uses configured chunking values to change produced boundaries');
  });
});
