import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import { ExtensionAcquisitionFatalError } from './errors.js';
import type { AgentHomeResolutionOptions } from './types.js';

const AGENT_HOME_ENVIRONMENT_VARIABLE = 'MY_AGENT_HOME';

export async function resolveAgentHome(
  options: AgentHomeResolutionOptions = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredPath = options.explicitPath !== undefined
    ? options.explicitPath
    : environment[AGENT_HOME_ENVIRONMENT_VARIABLE] ?? join(homeDirectory, '.my-agent');

  if (configuredPath.trim().length === 0) {
    throw new ExtensionAcquisitionFatalError(
      'AGENT_HOME_INVALID',
      'Agent Home must be a non-blank absolute path.',
    );
  }

  const expandedPath = expandHomeDirectory(configuredPath, homeDirectory);
  if (!isAbsolute(expandedPath)) {
    throw new ExtensionAcquisitionFatalError(
      'AGENT_HOME_INVALID',
      'Agent Home must be a non-blank absolute path.',
    );
  }

  const normalizedPath = normalize(expandedPath);
  let lexicalStats;
  try {
    lexicalStats = await lstat(normalizedPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return normalizedPath;
    throw new ExtensionAcquisitionFatalError(
      'AGENT_HOME_INVALID',
      'Agent Home could not be resolved.',
    );
  }
  if (!lexicalStats.isDirectory() && !lexicalStats.isSymbolicLink()) {
    throw new ExtensionAcquisitionFatalError(
      'AGENT_HOME_INVALID',
      'Agent Home must resolve to a directory.',
    );
  }
  try {
    const canonicalPath = await realpath(normalizedPath);
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new ExtensionAcquisitionFatalError(
        'AGENT_HOME_INVALID',
        'Agent Home must resolve to a directory.',
      );
    }
    return canonicalPath;
  } catch {
    throw new ExtensionAcquisitionFatalError(
      'AGENT_HOME_INVALID',
      'Agent Home could not be resolved.',
    );
  }
}

function expandHomeDirectory(value: string, homeDirectory: string): string {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDirectory, value.slice(2));
  }
  return value;
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}
