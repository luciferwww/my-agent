import { describe, expect, it } from 'vitest';
import type { MemoryManager } from '../../../core/memory/index.js';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
} from '../../../runtime/registry-builder.js';
import { createMemoryToolsContribution } from './contribution.js';

describe('Memory Tools Runtime Contribution', () => {
  it('stages every Memory Tool through the portable schema profile', () => {
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [createMemoryToolsContribution({} as MemoryManager)].map(stageRegistryUnit),
    });
    const snapshot = finalizeRegistrySnapshot({
      candidate,
      acceptedUnits: candidate.units,
      channelBindings: [],
      generation: 1,
    });

    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.tools.definitions.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'memory_search',
      'memory_get',
      'memory_write',
    ]));
    for (const definition of snapshot.tools.definitions) {
      expect(definition.inputSchema.type).toBe('object');
      expect(snapshot.tools.resolve(definition.name)?.validator.validate({}).errors)
        .toEqual(expect.any(Array));
    }
  });
});
