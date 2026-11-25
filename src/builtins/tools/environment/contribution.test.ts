import { describe, expect, it } from 'vitest';
import {
  finalizeRegistrySnapshot,
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
} from '../../../runtime/composition/registry-builder.js';
import { createEnvironmentContribution } from './contribution.js';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxConfig } from './process/sandbox/config.js';
import { getSandboxDependencyReads } from './process/sandbox/dependencies.js';
import { TEST_TOOL_CONTEXT } from '../../../core/tools/test-utils.js';

function toolProjection(options: Parameters<typeof createEnvironmentContribution>[0]) {
  const candidate = resolveStagedRegistryCandidate({
    providers: [], units: [createEnvironmentContribution(options)].map(stageRegistryUnit),
  });
  return finalizeRegistrySnapshot({ candidate, acceptedUnits: candidate.units, channelBindings: [], generation: 1 }).tools;
}

describe('Environment Runtime Contribution', () => {
  it('checks seven tools against shared baseline and user grants without leaking filtered subtrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-policy-'));
    const work = join(root, 'work');
    const denied = join(work, 'private');
    const allowed = join(denied, 'allowed');
    const baseline = join(work, 'trusted.txt');
    try {
      await mkdir(allowed, { recursive: true });
      await writeFile(baseline, 'BASELINE');
      await writeFile(join(work, 'note.txt'), 'needle');
      await writeFile(join(denied, 'secret.txt'), 'needle secret');
      await writeFile(join(allowed, 'visible.txt'), 'needle allowed');
      const reads = [...await getSandboxDependencyReads(), baseline];
      const tools = toolProjection({
        agentHome: root, execEnabled: false, processEnabled: false, webFetchEnabled: false,
        dependencyReads: reads,
        sandbox: resolveSandboxConfig({ enabled: true, write: [work, allowed], deny: [denied] }),
      });
      const execute = (name: string, input: Record<string, unknown>) => {
        const tool = tools.resolve(name);
        if (!tool) throw new Error(`Missing tool: ${name}`);
        return tool.execute(input, TEST_TOOL_CONTEXT);
      };
      expect((await execute('read_file', { path: baseline })).content).toContain('BASELINE');
      for (const path of [join(denied, 'secret.txt'), join(root, 'config.json')]) {
        expect((await execute('read_file', { path })).outcome).toBe('failed');
      }
      expect((await execute('write_file', { path: baseline, content: 'REPLACED' })).outcome).toBe('failed');
      expect((await execute('edit_file', { path: baseline, oldText: 'BASELINE', newText: 'REPLACED' })).outcome).toBe('failed');
      expect(await readFile(baseline, 'utf8')).toBe('BASELINE');
      const listed = await execute('list_dir', { path: work });
      expect(listed.outcome).toBe('success');
      expect(listed.content).not.toContain('private');
      const searched = await execute('file_search', { path: work, query: '*.txt' });
      expect(searched.outcome).toBe('success');
      expect(searched.content).toContain('note.txt');
      expect(searched.content).not.toContain('visible.txt');
      const grep = await execute('grep_search', { path: work, query: 'needle', isRegexp: false });
      expect(grep.outcome).toBe('success');
      expect(grep.content).not.toContain('secret');
      expect((await execute('grep_search', { path: allowed, query: 'needle', isRegexp: false })).content).toContain('visible.txt');
      const generated = join(work, 'new', 'generated.txt');
      expect((await execute('write_file', { path: generated, content: 'old' })).outcome).toBe('success');
      expect((await execute('edit_file', { path: generated, oldText: 'old', newText: 'new' })).outcome).toBe('success');
      const rejected = await execute('apply_patch', { input: [
        '*** Begin Patch', `*** Add File: ${join(work, 'must-not-exist.txt')}`, '+first',
        `*** Update File: ${generated}`, `*** Move to: ${baseline}`, '@@', '-new', '+moved', '*** End Patch',
      ].join('\n') });
      expect(rejected.outcome).toBe('failed');
      await expect(readFile(join(work, 'must-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(generated, 'utf8')).toBe('new');
      const moved = join(work, 'moved.txt');
      expect((await execute('apply_patch', { input: [
        '*** Begin Patch', `*** Update File: ${generated}`, `*** Move to: ${moved}`,
        '@@', '-new', '+moved', '*** End Patch',
      ].join('\n') })).outcome).toBe('success');
      expect(await readFile(moved, 'utf8')).toBe('moved\n');
      await expect(readFile(generated)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('removes an allowed junction/link without reading or deleting its denied target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-link-'));
    const work = join(root, 'work');
    const outside = join(root, 'outside');
    const alias = join(work, 'alias');
    try {
      await mkdir(work);
      await mkdir(outside);
      await writeFile(join(outside, 'secret.txt'), 'KEEP');
      await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const tools = toolProjection({
        agentHome: root, execEnabled: false, processEnabled: false, webFetchEnabled: false,
        sandbox: resolveSandboxConfig({ enabled: true, write: [work], deny: [outside] }),
      });
      const read = tools.resolve('read_file')!;
      expect((await read.execute({ path: join(alias, 'secret.txt') }, TEST_TOOL_CONTEXT)).outcome).toBe('failed');
      const patch = tools.resolve('apply_patch')!;
      expect((await patch.execute({ input: `*** Begin Patch\n*** Delete File: ${alias}\n*** End Patch` },
        TEST_TOOL_CONTEXT)).outcome).toBe('success');
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('KEEP');
      await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      expect((await patch.execute({ input: [
        '*** Begin Patch', `*** Delete File: ${alias}`, `*** Add File: ${alias}`,
        '+LOCAL_REPLACEMENT', '*** End Patch',
      ].join('\n') }, TEST_TOOL_CONTEXT)).outcome).toBe('success');
      expect(await readFile(alias, 'utf8')).toBe('LOCAL_REPLACEMENT\n');
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('KEEP');
      await rm(alias);
      await symlink(join(root, 'missing-target'), alias, process.platform === 'win32' ? 'junction' : 'dir');
      const listing = await tools.resolve('list_dir')!.execute({ path: work }, TEST_TOOL_CONTEXT);
      expect(listing.outcome).toBe('failed');
      expect(listing.content).toContain('ENOENT');
      expect((await patch.execute({ input: `*** Begin Patch\n*** Delete File: ${alias}\n*** End Patch` },
        TEST_TOOL_CONTEXT)).outcome).toBe('success');
      expect((await tools.resolve('list_dir')!.execute({ path: work }, TEST_TOOL_CONTEXT)).outcome).toBe('success');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not enforce saved path rules when Sandbox is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-off-'));
    try {
      const path = join(root, 'file.txt');
      const tools = toolProjection({
        agentHome: root, execEnabled: false, processEnabled: false, webFetchEnabled: false,
        dependencyReads: [root], sandbox: resolveSandboxConfig({ enabled: false, deny: [root] }),
      });
      expect((await tools.resolve('write_file')!.execute({ path, content: 'HOST' }, TEST_TOOL_CONTEXT)).outcome).toBe('success');
      expect((await tools.resolve('read_file')!.execute({ path }, TEST_TOOL_CONTEXT)).content).toContain('HOST');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

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
