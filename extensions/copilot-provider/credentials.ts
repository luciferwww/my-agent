import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LoginError } from './auth.js';

export interface Credentials {
  load(): Promise<string | undefined>;
  save(accessToken: string, signal: AbortSignal): Promise<void>;
  clear(): Promise<void>;
}

export class FileCredentials implements Credentials {
  readonly file: string;

  constructor(readonly directory = join(homedir(), '.my-agent', 'copilot-provider-login-spike')) {
    this.file = join(directory, 'github-token.json');
  }

  async load(): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new LoginError('Could not read the Copilot credential file. Check file permissions.');
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new LoginError('The Copilot credential file is invalid. Remove it and sign in again.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('version' in value) || value.version !== 1
      || !('githubToken' in value) || typeof value.githubToken !== 'string'
      || !/^[\x21-\x7e]{1,65536}$/.test(value.githubToken)) {
      throw new LoginError('The Copilot credential file is invalid. Remove it and sign in again.');
    }
    return value.githubToken;
  }

  async save(accessToken: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!/^[\x21-\x7e]{1,65536}$/.test(accessToken)) throw new LoginError('The GitHub credential is invalid.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.token-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, githubToken: accessToken })}\n`, {
        flag: 'wx', mode: 0o600, signal,
      });
      if (process.platform !== 'win32') await chmod(temporary, 0o600);
      signal.throwIfAborted();
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
