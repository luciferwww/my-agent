import { describe, expect, it } from 'vitest';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
} from '../../../runtime/registry-builder.js';
import { createEnvironmentContribution } from './contribution.js';

describe('Environment Runtime Contribution', () => {
  it('stages every Environment Tool through the portable schema profile', () => {
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [createEnvironmentContribution({
        agentHome: 'C:/agent-home',
        webFetchEnabled: true,
        execEnabled: true,
        processEnabled: true,
      })].map(stageRegistryUnit),
    });
    const snapshot = finalizeRegistrySnapshot({
      candidate,
      acceptedUnits: candidate.units,
      channelBindings: [],
      generation: 1,
    });

    expect(candidate.units.map(({ unit }) => unit.id)).toContain('builtin-environment');
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.tools.definitions.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'list_dir',
      'read_file',
      'file_search',
      'grep_search',
      'apply_patch',
      'write_file',
      'edit_file',
      'web_fetch',
      'exec',
      'process',
    ]));
    for (const definition of snapshot.tools.definitions) {
      expect(definition.inputSchema.type).toBe('object');
      expect(snapshot.tools.resolve(definition.name)?.validator.validate({}).errors)
        .toEqual(expect.any(Array));
    }

    const definitions = new Map(snapshot.tools.definitions.map((definition) => [
      definition.name,
      definition,
    ]));
    expect(definitions.get('write_file')?.description).toContain('prefer edit_file');
    expect(definitions.get('write_file')?.description).toContain('apply_patch');
    expect(definitions.get('edit_file')?.description).toContain('one localized change');
    expect(definitions.get('apply_patch')?.description).toContain('preserving untouched content');
    expect(JSON.stringify(definitions.get('apply_patch')?.inputSchema))
      .toContain('*** Update File:');
  });
});
