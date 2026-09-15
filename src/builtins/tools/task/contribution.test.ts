import { describe, expect, it } from 'vitest';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
} from '../../../runtime/registry-builder.js';
import { createTaskToolContribution } from './contribution.js';

describe('Task Tool Runtime Contribution', () => {
  it('stages the Task Tool through the portable schema profile', () => {
    const profileRegistry = new Map([[
      'general-purpose',
      {
        id: 'general-purpose',
        description: 'General purpose',
        agentDir: 'C:/workspace/.agent/subagents/general-purpose',
        model: 'inherit' as const,
      },
    ]]);
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [createTaskToolContribution({
        delegationPort: { delegate: async () => { throw new Error('not executed'); } },
        profileRegistry,
        getCapabilities: () => ({ depth: 0, role: 'main', canSpawn: true }),
        maxDepth: 1,
      })].map(stageRegistryUnit),
    });
    const snapshot = finalizeRegistrySnapshot({
      candidate,
      acceptedUnits: candidate.units,
      channelBindings: [],
      generation: 1,
    });

    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.tools.definitions.map(({ name }) => name)).toContain('task');
    const definition = snapshot.tools.definitions.find(({ name }) => name === 'task');
    expect(definition?.inputSchema.type).toBe('object');
    expect(snapshot.tools.resolve('task')?.validator.validate({}).errors)
      .toEqual(expect.any(Array));
  });
});
