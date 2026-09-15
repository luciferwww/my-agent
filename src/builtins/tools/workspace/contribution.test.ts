import { describe, expect, it } from 'vitest';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
} from '../../../runtime/registry-builder.js';
import { createWorkspaceToolsContribution } from './contribution.js';

describe('Workspace Tools Runtime Contribution', () => {
  it('stages every Workspace Tool through the portable schema profile', () => {
    const candidate = resolveStagedRegistryCandidate({
      providers: [],
      units: [createWorkspaceToolsContribution({
        workspaceDir: 'C:/workspace',
        fsWorkspaceOnly: true,
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
  });
});
