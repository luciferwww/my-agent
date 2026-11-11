import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadAgentProfiles, buildGeneralPurposeProfile, type AgentProfileOverride } from './config-loader.js';
import type { AgentDefinition } from '../agent-context/index.js';

const registered = new Set(['read_file', 'write_file', 'exec', 'task']);
const recommendation = { providerId: 'recommended', modelId: 'recommended-model' };
const definition: AgentDefinition = {
  id: 'reviewer', description: 'MD description', model: recommendation,
  agentDir: join('C:\\home', 'agents', 'reviewer'),
  contextFiles: [], sourceFiles: [], missingFiles: [],
};
const load = (overrides: readonly AgentProfileOverride[] = [], definitions = [definition]) =>
  loadAgentProfiles(definitions, overrides, registered);

describe('discovered Agent profiles', () => {
  it('registers a definition with no configuration entry', () => {
    expect(load()).toEqual([expect.objectContaining({
      id: 'reviewer', description: 'MD description', model: recommendation,
      agentDir: definition.agentDir,
    })]);
  });

  it('does not register configuration-only Agents', () => {
    expect(load([{ id: 'missing', description: 'Not a definition' }], [])).toEqual([]);
  });

  it('keeps definition order and excludes explicitly disabled definitions', () => {
    const definitions = [{ ...definition, id: 'a' }, { ...definition, id: 'b' }];
    expect(load([{ id: 'a', enabled: false }], definitions).map(profile => profile.id)).toEqual(['b']);
    expect(load([{ id: 'reviewer', enabled: true }])).toHaveLength(1);
  });

  it('applies sparse description and Tool overrides without requiring metadata duplication', () => {
    const tools = { allow: [], deny: ['exec'] };
    expect(load([{ id: 'reviewer', description: 'Config description', tools }])[0])
      .toMatchObject({ description: 'Config description', model: recommendation, tools });
  });

  it.each([
    [undefined, recommendation],
    ['inherit' as const, 'inherit'],
    [{ providerId: 'explicit', modelId: 'explicit-model' }, { providerId: 'explicit', modelId: 'explicit-model' }],
  ])('resolves model precedence for %s', (model, expected) => {
    expect(load([{ id: 'reviewer', model }])[0].model).toEqual(expected);
  });

  it('inherits the parent model when neither source recommends one', () => {
    expect(load([], [{ ...definition, model: undefined }])[0].model).toBe('inherit');
  });

  it.each(['', 'Reviewer', 'bad.id', '-bad', 'x'.repeat(65), 'general-purpose'])(
    'rejects invalid or reserved override ID %s even without a definition', id => {
      expect(() => load([{ id }], [])).toThrow(/invalid or reserved/);
    },
  );
  it('accepts existing ID boundaries', () => {
    for (const id of ['a', 'agent_7', 'code-reviewer', 'x'.repeat(64)]) {
      expect(() => load([{ id }], [])).not.toThrow();
    }
  });
  it('rejects duplicate IDs, blank descriptions and blank model references', () => {
    expect(() => load([{ id: 'a' }, { id: 'a' }])).toThrow(/duplicate/);
    expect(() => load([{ id: 'reviewer', description: ' ' }])).toThrow(/description/);
    expect(() => load([{ id: 'reviewer', model: { providerId: 'test', modelId: ' ' } }])).toThrow(/model/);
  });
  it('validates exact allow names while preserving globs and explicit empty allow', () => {
    expect(() => load([{ id: 'reviewer', tools: { allow: ['unknown'] } }])).toThrow(/unknown tool/);
    expect(load([{ id: 'reviewer', tools: { allow: ['read_file', 'task', 'file_*', 'exec?'] } }])[0].tools?.allow)
      .toEqual(['read_file', 'task', 'file_*', 'exec?']);
    expect(load([{ id: 'reviewer', tools: { allow: [] } }])[0].tools?.allow).toEqual([]);
  });
});

describe('permanent general-purpose profile', () => {
  it('is model-inheriting and has no independent Tool override', () => {
    const profile = buildGeneralPurposeProfile('C:\\home');
    expect(profile.id).toBe('general-purpose');
    expect(profile.description).not.toBe('');
    expect(profile.model).toBe('inherit');
    expect(profile.tools).toBeUndefined();
  });
});
