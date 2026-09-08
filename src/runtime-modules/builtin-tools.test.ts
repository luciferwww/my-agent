import { describe, expect, it } from 'vitest';
import type { MemoryManager } from '../core/memory/index.js';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
} from '../runtime/registry-builder.js';
import {
  createMemoryToolModule,
  createTaskToolModule,
  createWorkspaceToolModule,
} from './builtin-tools.js';

describe('Builtin Tool Runtime Modules', () => {
  it('stages every Builtin Tool through the portable schema profile', () => {
    const profileRegistry = new Map([
      ['general-purpose', {
        id: 'general-purpose',
        description: 'General purpose',
        agentDir: 'C:/workspace/.agent/subagents/general-purpose',
        model: 'inherit' as const,
      }],
    ]);
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [
        createWorkspaceToolModule({
          workspaceDir: 'C:/workspace',
          fsWorkspaceOnly: true,
          webFetchEnabled: true,
          execEnabled: true,
          processEnabled: true,
        }),
        createMemoryToolModule({} as MemoryManager),
        createTaskToolModule({
          delegationPort: { delegate: async () => { throw new Error('not executed'); } },
          profileRegistry,
          getCapabilities: () => ({ depth: 0, role: 'main', canSpawn: true }),
          maxDepth: 1,
        }),
      ].map(stageRegistryUnit),
    });
    const snapshot = finalizeRegistrySnapshot({
      candidate,
      acceptedUnits: candidate.units,
      channelBindings: [],
      generation: 1,
    });

    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.tools.definitions.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'list_dir',
      'read_file',
      'web_fetch',
      'exec',
      'process',
      'memory_search',
      'memory_get',
      'memory_write',
      'task',
    ]));
    for (const definition of snapshot.tools.definitions) {
      expect(definition.inputSchema.type).toBe('object');
      expect(snapshot.tools.resolve(definition.name)?.validator.validate({}).errors)
        .toEqual(expect.any(Array));
    }
  });
});
