import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  ModelResolutionError, normalizeModelReference, type ModelReference,
} from '../model-resolution/index.js';
import { prepareContextFiles, type LoadContextFilesOptions } from './loader.js';
import type { ContextFile } from './types.js';

const CONTEXT_FILENAMES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md'] as const;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function isNamedAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID.test(value) && value !== 'general-purpose';
}

export interface AgentDefinition {
  readonly id: string;
  readonly agentDir: string;
  readonly description: string;
  readonly model?: ModelReference;
  readonly missingFiles: readonly string[];
  readonly contextFiles: readonly Readonly<ContextFile>[];
  readonly sourceFiles: readonly Readonly<ContextFile>[];
}

export interface AgentDefinitionDiagnostic {
  readonly agentId: string;
  readonly path: string;
  readonly code: 'invalid_definition' | 'read_failed' | 'context_truncated';
  readonly message: string;
}

export interface AgentDefinitionSnapshot {
  readonly definitions: readonly AgentDefinition[];
  readonly diagnostics: readonly AgentDefinitionDiagnostic[];
}

class AgentDefinitionError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'AgentDefinitionError';
  }
}

export async function loadAgentDefinitions(
  agentHome: string,
  options?: Pick<LoadContextFilesOptions, 'maxFileChars' | 'maxTotalChars'>,
): Promise<AgentDefinitionSnapshot> {
  const root = join(agentHome, 'agents');
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`Agent definitions path must be a directory: ${root}`);
  }
  const definitions: AgentDefinition[] = [];
  const diagnostics: AgentDefinitionDiagnostic[] = [];
  const entries = (await readdir(root, { withFileTypes: true }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  for (const entry of entries) {
    const agentDir = join(root, entry.name);
    if (entry.isFile()) continue;
    try {
      if (!entry.isDirectory()) {
        throw new AgentDefinitionError(agentDir, 'Agent definition must be a directory, not a link.');
      }
      if (!isNamedAgentId(entry.name)) {
        throw new AgentDefinitionError(agentDir, 'Agent ID is invalid or reserved.');
      }
      const sourceFiles: ContextFile[] = [];
      for (const name of CONTEXT_FILENAMES) {
        const path = join(agentDir, name);
        let file;
        try {
          file = await lstat(path);
        } catch (error) {
          if (hasCode(error, 'ENOENT')) continue;
          throw error;
        }
        if (!file.isFile()) {
          throw new AgentDefinitionError(path, 'Agent Context must be a regular file, not a link.');
        }
        sourceFiles.push({ path: name, content: await readFile(path, 'utf8') });
      }
      const identityPath = join(agentDir, 'IDENTITY.md');
      const identity = sourceFiles.find(file => file.path === 'IDENTITY.md');
      if (!identity) {
        throw new AgentDefinitionError(identityPath, 'IDENTITY.md with description metadata is required.');
      }
      const metadata = parseAgentIdentity(identity.content, identityPath);
      const contextFiles = sourceFiles.map(file => file.path === 'IDENTITY.md'
        ? { path: file.path, content: metadata.body }
        : file);
      const warn = (message: string) => diagnostics.push(Object.freeze({
        agentId: entry.name, path: agentDir, code: 'context_truncated' as const, message,
      }));
      definitions.push(Object.freeze({
        id: entry.name,
        agentDir,
        description: metadata.description,
        ...(metadata.model === undefined ? {} : { model: metadata.model }),
        missingFiles: Object.freeze(CONTEXT_FILENAMES
          .filter(name => !sourceFiles.some(file => file.path === name))),
        contextFiles: freezeFiles(prepareContextFiles(contextFiles, { ...options, warn })),
        sourceFiles: freezeFiles(prepareContextFiles(sourceFiles, {
          ...options, warn: message => warn(`Read-only source: ${message}`),
        })),
      }));
    } catch (error) {
      if (error instanceof AgentDefinitionError) {
        diagnostics.push(Object.freeze({
          agentId: entry.name, path: error.path, code: 'invalid_definition', message: error.message,
        }));
      } else if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        diagnostics.push(Object.freeze({
          agentId: entry.name, path: agentDir, code: 'read_failed',
          message: `Agent definition could not be read (${error.code}).`,
        }));
      } else {
        throw error;
      }
    }
  }
  return Object.freeze({
    definitions: Object.freeze(definitions),
    diagnostics: Object.freeze(diagnostics),
  });
}

function parseAgentIdentity(source: string, path: string): {
  description: string;
  model?: ModelReference;
  body: string;
} {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu.exec(source);
  if (!match || match.index !== 0) {
    throw new AgentDefinitionError(path, 'IDENTITY.md must start with closed YAML frontmatter.');
  }
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new AgentDefinitionError(path, 'IDENTITY.md frontmatter is invalid YAML.');
  }
  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new AgentDefinitionError(path, 'IDENTITY.md frontmatter must not contain aliases.');
  }
  if (!isObject(metadata)) {
    throw new AgentDefinitionError(path, 'IDENTITY.md frontmatter must be an object.');
  }
  const unsupportedField = Object.keys(metadata).find(key => key !== 'description' && key !== 'model');
  if (unsupportedField !== undefined) {
    throw new AgentDefinitionError(path, `IDENTITY.md frontmatter has an unsupported field: ${unsupportedField}.`);
  }
  if (typeof metadata.description !== 'string' || metadata.description.trim() === '') {
    throw new AgentDefinitionError(path, 'IDENTITY.md description must be nonblank text.');
  }
  let model: ModelReference | undefined;
  if (metadata.model !== undefined) {
    const value = metadata.model;
    if (!isObject(value)
      || Object.keys(value).some(key => key !== 'providerId' && key !== 'modelId')
      || typeof value.providerId !== 'string' || value.providerId.trim() === ''
      || typeof value.modelId !== 'string' || value.modelId.trim() === '') {
      throw new AgentDefinitionError(path, 'IDENTITY.md model must contain nonblank providerId and modelId.');
    }
    try {
      model = normalizeModelReference({ providerId: value.providerId, modelId: value.modelId });
    } catch (error) {
      if (!(error instanceof ModelResolutionError)) throw error;
      throw new AgentDefinitionError(path, 'IDENTITY.md model.providerId is invalid.');
    }
  }
  return {
    description: metadata.description.trim(),
    ...(model === undefined ? {} : { model }),
    body: source.slice(match[0].length),
  };
}

function freezeFiles(files: ContextFile[]): readonly Readonly<ContextFile>[] {
  return Object.freeze(files.map(file => Object.freeze(file)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
