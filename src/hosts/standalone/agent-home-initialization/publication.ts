import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { ensureAgentContext } from '../../../core/agent-context/index.js';
import { FIXED_AGENT_PROFILES } from './assets.js';

const CONFIG_FILE = 'config.json';

export async function readAgentHomeConfig(agentHome: string): Promise<string | undefined> {
  return readOptionalFile(join(agentHome, CONFIG_FILE));
}

export async function preflightAgentHome(
  agentHome: string,
  expectedConfig?: string,
): Promise<void> {
  const current = await readAgentHomeConfig(agentHome);
  if (expectedConfig === undefined && current !== undefined) {
    throw new Error('Agent Home is already configured. Initialization did not change it.');
  }
  if (expectedConfig !== undefined && current !== expectedConfig) {
    throw new Error('Agent Home configuration changed during editing. No changes were saved.');
  }
  if (expectedConfig !== undefined) return;
  await assertCompatibleProfileFiles(agentHome);
}

export async function publishAgentHome(
  agentHome: string,
  serializedConfig: string,
  expectedConfig?: string,
): Promise<void> {
  await preflightAgentHome(agentHome, expectedConfig);
  if (expectedConfig !== undefined) {
    await replaceConfig(agentHome, serializedConfig, expectedConfig);
    return;
  }
  await ensureAgentContext(agentHome);
  for (const profile of FIXED_AGENT_PROFILES) {
    const directory = join(agentHome, 'agents', profile.id);
    await mkdir(directory, { recursive: true });
    for (const [fileName, content] of Object.entries(profile.files)) {
      await writeCompatibleFile(join(directory, fileName), content, agentHome);
    }
  }
  try {
    await writeFile(join(agentHome, CONFIG_FILE), serializedConfig, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error('Agent Home became configured during initialization.');
    }
    throw error;
  }
}

async function replaceConfig(
  agentHome: string,
  serializedConfig: string,
  expectedConfig: string,
): Promise<void> {
  const configPath = join(agentHome, CONFIG_FILE);
  const temporaryPath = join(agentHome, `${CONFIG_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, serializedConfig, { encoding: 'utf8', flag: 'wx' });
    if (await readAgentHomeConfig(agentHome) !== expectedConfig) {
      throw new Error('Agent Home configuration changed during editing. No changes were saved.');
    }
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function assertCompatibleProfileFiles(agentHome: string): Promise<void> {
  for (const profile of FIXED_AGENT_PROFILES) {
    for (const [fileName, content] of Object.entries(profile.files)) {
      const path = join(agentHome, 'agents', profile.id, fileName);
      const existing = await readOptionalFile(path);
      if (existing !== undefined && existing !== content) {
        throw conflictingFileError(agentHome, path);
      }
    }
  }
}

async function writeCompatibleFile(
  path: string,
  content: string,
  agentHome: string,
): Promise<void> {
  const existing = await readOptionalFile(path);
  if (existing !== undefined) {
    if (existing !== content) throw conflictingFileError(agentHome, path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (await readOptionalFile(path) !== content) throw conflictingFileError(agentHome, path);
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function conflictingFileError(agentHome: string, path: string): Error {
  const relativePath = path.slice(agentHome.length).replace(/^[\\/]+/u, '').replaceAll('\\', '/');
  return new Error(
    `Agent Home contains a conflicting initialization file: ${relativePath}. The existing file was not overwritten.`,
  );
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}
