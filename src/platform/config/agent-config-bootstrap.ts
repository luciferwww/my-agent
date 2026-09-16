import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentConfigError } from './agent-config-errors.js';

const CONFIG_FILE_NAME = 'config.json';
const EMPTY_CONFIG_DOCUMENT = '{}\n';

interface AgentConfigBootstrapDependencies {
  ensureDirectory(path: string): Promise<void>;
  createTextFile(path: string, content: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: AgentConfigBootstrapDependencies = {
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  createTextFile: async (path, content) => {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  },
};

/** Exclusively materializes the empty Agent configuration document when it is absent. */
export async function ensureAgentConfigDocument(
  options: { readonly agentHome: string },
  dependencies: AgentConfigBootstrapDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  try {
    await dependencies.ensureDirectory(options.agentHome);
  } catch {
    throw new AgentConfigError(
      'AGENT_HOME_CREATE_FAILED',
      'Agent Home could not be created for configuration bootstrap.',
    );
  }

  try {
    await dependencies.createTextFile(
      join(options.agentHome, CONFIG_FILE_NAME),
      EMPTY_CONFIG_DOCUMENT,
    );
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return;
    throw new AgentConfigError(
      'FILE_CREATE_FAILED',
      'Agent configuration file could not be created.',
    );
  }
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}
