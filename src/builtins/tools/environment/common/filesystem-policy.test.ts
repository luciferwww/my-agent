import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesystemPolicy } from './filesystem-policy.js';
import { resolveSandboxConfig } from '../process/sandbox/config.js';

let root: string;
let work: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'filesystem-policy-'));
  work = join(root, 'work');
  outside = join(root, 'outside');
  await mkdir(work);
  await mkdir(outside);
  await writeFile(join(outside, 'data.txt'), 'OUTSIDE');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('software filesystem policy', () => {
  it('inherits grants for new children with strict equal-path rules and specific child exceptions', async () => {
    await mkdir(join(work, 'secret'));
    const policy = createFilesystemPolicy(resolveSandboxConfig({
      enabled: true, read: [work], write: [work, join(work, 'cache'), join(work, 'secret', 'allowed')],
      deny: [join(work, 'secret')],
    }))!;
    await expect(policy.assert(join(work, 'new.txt'), 'read')).resolves.toBeUndefined();
    await expect(policy.assertWrite(join(work, 'new.txt'))).rejects.toThrow('rejects write');
    await expect(policy.assertWrite(join(work, 'cache', 'nested', 'new.txt'))).resolves.toBeUndefined();
    await expect(policy.canRead(join(work, 'secret'))).resolves.toBe(false);
    await expect(policy.assertWrite(join(work, 'secret', 'allowed', 'new.txt'))).resolves.toBeUndefined();
    await expect(policy.assert(join(outside, 'data.txt'), 'read')).rejects.toThrow('rejects read');
    await expect(policy.assert(join(root, 'work-other.txt'), 'read')).rejects.toThrow('rejects read');
  });

  it('rejects creating unauthorized parents when only a missing leaf is writable', async () => {
    const leaf = join(work, 'missing', 'file.txt');
    const policy = createFilesystemPolicy(resolveSandboxConfig({ enabled: true, write: [leaf] }))!;
    await expect(policy.assertWrite(leaf)).rejects.toThrow('rejects write');
    await expect(readFile(leaf)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks real targets and missing tails, but distinguishes removing a link entry', async () => {
    const alias = join(work, 'alias');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const policy = createFilesystemPolicy(resolveSandboxConfig({ enabled: true, write: [work] }))!;
    await expect(policy.assert(join(alias, 'data.txt'), 'read')).rejects.toThrow('rejects read');
    await expect(policy.assertWrite(join(alias, 'missing', 'file.txt'))).rejects.toThrow('rejects write');
    await expect(policy.assert(alias, 'write', 'entry')).resolves.toBeUndefined();
    expect(await readFile(join(outside, 'data.txt'), 'utf8')).toBe('OUTSIDE');
    await rm(alias);
    await symlink(join(root, 'not-present'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(policy.canRead(join(alias, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(policy.assert(alias, 'write', 'entry')).resolves.toBeUndefined();
  });

  it('refreshes policy aliases between operations and protects baseline resources from broad writes', async () => {
    const alias = join(root, 'reference');
    await symlink(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const policy = createFilesystemPolicy(resolveSandboxConfig({ enabled: true, write: [root] }), [alias])!;
    await expect(policy.assertWrite(join(work, 'new.txt'))).rejects.toThrow('rejects write');
    await rm(alias);
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(policy.assertWrite(join(work, 'new.txt'))).resolves.toBeUndefined();
    await expect(policy.assertWrite(join(outside, 'data.txt'))).rejects.toThrow('rejects write');
    const exception = createFilesystemPolicy(resolveSandboxConfig({
      enabled: true, write: [join(outside, 'cache')],
    }), [outside])!;
    await expect(exception.assertWrite(join(outside, 'cache', 'new.txt'))).resolves.toBeUndefined();
    expect(createFilesystemPolicy(resolveSandboxConfig({ deny: [root] }), [root])).toBeUndefined();
  });
});
