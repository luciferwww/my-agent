import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentPathContext } from '../path-context.js';

const PACKAGE_NAME = 'my-agent';

export type StandaloneHostPathErrorCode =
  | 'INSTALL_DIR_INVALID'
  | 'AGENT_HOME_INVALID'
  | 'WORKING_DIR_INVALID';

export class StandaloneHostPathError extends Error {
  readonly code: StandaloneHostPathErrorCode;

  constructor(code: StandaloneHostPathErrorCode, message: string) {
    super(message);
    this.name = 'StandaloneHostPathError';
    this.code = code;
  }
}

export interface StandaloneHostPathResolutionOptions {
  readonly moduleUrl: string;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}

export async function resolveStandaloneHostPathContext(
  options: StandaloneHostPathResolutionOptions,
): Promise<AgentPathContext> {
  const [installDir, agentHome, workingDir] = await Promise.all([
    resolveInstallDir(options.moduleUrl),
    resolveAgentHome(options.homeDirectory),
    resolveWorkingDir(options.workingDirectory),
  ]);
  return Object.freeze({ installDir, agentHome, workingDir });
}

async function resolveInstallDir(moduleUrl: string): Promise<string> {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
    if (!(await stat(modulePath)).isFile()) throw new Error('not a file');
  } catch {
    throw pathError('INSTALL_DIR_INVALID');
  }

  let candidate = dirname(modulePath);
  const root = parse(candidate).root;
  while (true) {
    const packageDocument = await readPackageDocument(join(candidate, 'package.json'));
    if (packageDocument?.name === PACKAGE_NAME) {
      try {
        return normalize(await realpath(candidate));
      } catch {
        throw pathError('INSTALL_DIR_INVALID');
      }
    }
    if (candidate === root) break;
    candidate = dirname(candidate);
  }
  throw pathError('INSTALL_DIR_INVALID');
}

async function readPackageDocument(
  packagePath: string,
): Promise<{ readonly name?: unknown } | undefined> {
  let raw: string;
  try {
    raw = await readFile(packagePath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
    throw pathError('INSTALL_DIR_INVALID');
  }
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveAgentHome(homeDirectory: string): Promise<string> {
  if (!isAbsolute(homeDirectory)) throw pathError('AGENT_HOME_INVALID');
  const agentHome = normalize(join(homeDirectory, '.my-agent'));
  let lexicalStats;
  try {
    lexicalStats = await lstat(agentHome);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return agentHome;
    throw pathError('AGENT_HOME_INVALID');
  }
  if (!lexicalStats.isDirectory() && !lexicalStats.isSymbolicLink()) {
    throw pathError('AGENT_HOME_INVALID');
  }
  try {
    const canonicalPath = await realpath(agentHome);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('not a directory');
    return normalize(canonicalPath);
  } catch {
    throw pathError('AGENT_HOME_INVALID');
  }
}

async function resolveWorkingDir(workingDirectory: string): Promise<string> {
  if (!isAbsolute(workingDirectory)) throw pathError('WORKING_DIR_INVALID');
  const normalizedPath = normalize(workingDirectory);
  try {
    if (!(await stat(normalizedPath)).isDirectory()) throw new Error('not a directory');
    return normalizedPath;
  } catch {
    throw pathError('WORKING_DIR_INVALID');
  }
}

function pathError(code: StandaloneHostPathErrorCode): StandaloneHostPathError {
  switch (code) {
    case 'INSTALL_DIR_INVALID':
      return new StandaloneHostPathError(code, 'Standalone installation directory is invalid.');
    case 'AGENT_HOME_INVALID':
      return new StandaloneHostPathError(code, 'Standalone Agent Home is invalid.');
    case 'WORKING_DIR_INVALID':
      return new StandaloneHostPathError(code, 'Standalone working directory is invalid.');
  }
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}