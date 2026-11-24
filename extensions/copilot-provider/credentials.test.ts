import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileCredentials } from './credentials.js';

const directories: string[] = [];
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
afterEach(async () => {
  vi.mocked(homedir).mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-credentials-test-'));
  directories.push(directory);
  return new FileCredentials(directory);
}

async function defaultFixture() {
  const home = await mkdtemp(join(tmpdir(), 'copilot-directory-migration-test-'));
  directories.push(home);
  vi.mocked(homedir).mockReturnValue(home);
  return {
    credentials: new FileCredentials(),
    legacy: new FileCredentials(join(home, '.my-agent', 'copilot-provider-login-spike')),
  };
}

it('migrates a valid legacy credential only after saving it in the new directory', async () => {
  const { credentials, legacy } = await defaultFixture();
  await legacy.save('synthetic-legacy-token', new AbortController().signal);
  await writeFile(join(legacy.directory, 'unrelated.txt'), 'keep');
  expect(await credentials.load()).toBe('synthetic-legacy-token');
  expect(await new FileCredentials().load()).toBe('synthetic-legacy-token');
  await expect(readFile(legacy.file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(legacy.directory, 'unrelated.txt'), 'utf8')).toBe('keep');
});

it('prefers the new credential without reading or migrating the legacy file', async () => {
  const { credentials, legacy } = await defaultFixture();
  await credentials.save('synthetic-new-token', new AbortController().signal);
  await mkdir(legacy.directory, { recursive: true });
  await writeFile(legacy.file, 'invalid legacy JSON');
  expect(await credentials.load()).toBe('synthetic-new-token');
  expect(await readFile(legacy.file, 'utf8')).toBe('invalid legacy JSON');
});

it('rejects invalid legacy credentials without migrating or deleting them', async () => {
  const { credentials, legacy } = await defaultFixture();
  await mkdir(legacy.directory, { recursive: true });
  await writeFile(legacy.file, 'invalid legacy JSON');
  await expect(credentials.load()).rejects.toThrow('credential file is invalid');
  await expect(readFile(credentials.file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(legacy.file, 'utf8')).toBe('invalid legacy JSON');
});

it('sign-out clears both credential locations so legacy access cannot return', async () => {
  const { credentials, legacy } = await defaultFixture();
  await legacy.save('synthetic-legacy-token', new AbortController().signal);
  await credentials.save('synthetic-new-token', new AbortController().signal);
  await credentials.clear();
  expect(await credentials.load()).toBeUndefined();
  await expect(readFile(legacy.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('persists and replaces a credential across instances without leaving temporary files', async () => {
  const credentials = await fixture();
  expect(await credentials.load()).toBeUndefined();
  await credentials.save('synthetic-first-token', new AbortController().signal);
  expect(await new FileCredentials(credentials.directory).load()).toBe('synthetic-first-token');
  await credentials.save('synthetic-replacement-token', new AbortController().signal);
  expect(await credentials.load()).toBe('synthetic-replacement-token');
  expect(await readdir(credentials.directory)).toEqual(['github-token.json']);
});

it.skipIf(process.platform === 'win32')('restricts existing POSIX directory and credential file permissions', async () => {
  const credentials = await fixture();
  await chmod(credentials.directory, 0o755);
  const mask = process.umask(0o777);
  try { await credentials.save('synthetic-token', new AbortController().signal); }
  finally { process.umask(mask); }
  expect((await stat(credentials.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(credentials.file)).mode & 0o777).toBe(0o600);
  expect(await credentials.load()).toBe('synthetic-token');
});

it.each([
  'not-json',
  '{"version":2,"githubToken":"synthetic-token"}',
  '{"version":1,"githubToken":"invalid token"}',
])('rejects invalid stored credentials instead of treating them as signed out: %s', async (text) => {
  const credentials = await fixture();
  await writeFile(credentials.file, text);
  await expect(credentials.load()).rejects.toThrow('credential file is invalid');
});

it('surfaces filesystem read failures instead of treating them as a missing credential', async () => {
  const credentials = await fixture();
  await mkdir(credentials.file);
  await expect(credentials.load()).rejects.toThrow('Could not read');
});

it('preserves the previous credential when saving is cancelled', async () => {
  const credentials = await fixture();
  await credentials.save('synthetic-existing-token', new AbortController().signal);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled test save'));
  await expect(credentials.save('synthetic-new-token', controller.signal)).rejects.toThrow('Cancelled test save');
  expect(await credentials.load()).toBe('synthetic-existing-token');
  expect(await readdir(credentials.directory)).toEqual(['github-token.json']);
});

it('sign-out removes only the saved credential and remains safe when already signed out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-signout-test-'));
  try {
    const credentials = new FileCredentials(directory);
    const other = join(directory, 'unrelated.txt');
    await writeFile(credentials.file, 'synthetic-protected-credential');
    await writeFile(other, 'keep');
    await credentials.clear();
    await credentials.clear();
    await expect(readFile(credentials.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(other, 'utf8')).toBe('keep');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
