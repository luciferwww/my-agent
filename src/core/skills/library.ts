import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { isSkillName } from './config.js';
import type { SkillSummary, SkillDiagnostic, SkillCatalog, LoadedSkill } from './types.js';

interface SkillPackage extends SkillSummary, LoadedSkill {}

export class SkillLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLibraryError';
  }
}

export async function discoverSkills(agentHome: string): Promise<SkillCatalog> {
  const { packages, diagnostics } = await scanSkills(agentHome);
  return {
    entries: packages.map(({ name, description, relativeDirectory }) => ({
      name, description, relativeDirectory,
    })),
    diagnostics,
  };
}

export async function loadSkill(agentHome: string, name: string): Promise<LoadedSkill> {
  if (!isSkillName(name)) throw new SkillLibraryError('Invalid Skill name.');
  const { packages, diagnostics } = await scanSkills(agentHome);
  const skill = packages.find(entry => entry.name === name);
  if (!skill) {
    const conflict = diagnostics.some(entry =>
      entry.code === 'duplicate_name' && basename(entry.path) === name);
    throw new SkillLibraryError(conflict
      ? `Skill "${name}" has conflicting packages.`
      : `Skill "${name}" is missing or invalid. Check the Skill catalog diagnostics.`);
  }
  return { name: skill.name, directory: skill.directory, content: skill.content };
}

async function scanSkills(agentHome: string): Promise<{
  packages: SkillPackage[];
  diagnostics: SkillDiagnostic[];
}> {
  const root = join(agentHome, 'skills');
  try {
    if (!(await lstat(root)).isDirectory()) {
      throw new SkillLibraryError('Skills root must be a regular directory, not a link.');
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { packages: [], diagnostics: [] };
    if (error instanceof SkillLibraryError) throw error;
    throw new SkillLibraryError(`Skills root could not be read${errorCode(error)}.`);
  }
  const canonicalRoot = await realpath(root);
  const candidates: SkillPackage[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const report = (path: string, code: SkillDiagnostic['code'], message: string) => {
    diagnostics.push({ path: relative(root, path), code, message });
  };
  const visit = async (directory: string): Promise<void> => {
    try {
      if (!(await lstat(directory)).isDirectory()) {
        throw new SkillLibraryError('Skill classification must be a directory, not a link.');
      }
      await checkContained(canonicalRoot, directory);
      const instructionPath = join(directory, 'SKILL.md');
      let instruction;
      try {
        instruction = await lstat(instructionPath);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      if (instruction !== undefined) {
        if (!instruction.isFile()) {
          throw new SkillLibraryError('SKILL.md must be a regular file, not a link.');
        }
        await checkContained(canonicalRoot, instructionPath);
        const content = await readFile(instructionPath, 'utf8');
        const metadata = parseSkill(content, basename(directory));
        candidates.push({
          ...metadata, relativeDirectory: relative(root, directory),
          directory, content,
        });
        return;
      }
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((a, b) => compare(a.name, b.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isSymbolicLink()) report(path, 'invalid_skill', 'Linked entries are not discovered.');
      }
    } catch (error) {
      if (error instanceof SkillLibraryError) report(directory, 'invalid_skill', error.message);
      else if (isFileSystemError(error)) report(directory, 'read_failed', `Skill directory could not be read${errorCode(error)}.`);
      else throw error;
    }
  };
  await visit(root);
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
  const packages = candidates.filter(candidate => {
    if (counts.get(candidate.name) === 1) return true;
    report(candidate.directory, 'duplicate_name', `Skill "${candidate.name}" has conflicting packages.`);
    return false;
  }).sort((a, b) => compare(a.name, b.name));
  diagnostics.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code));
  if (diagnostics.some(entry => entry.path === '')) {
    throw new SkillLibraryError(diagnostics.find(entry => entry.path === '')!.message);
  }
  return { packages, diagnostics };
}

function parseSkill(content: string, directoryName: string): Pick<SkillSummary, 'name' | 'description'> {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu.exec(content);
  if (!match || match.index !== 0) throw new SkillLibraryError('SKILL.md must start with closed YAML frontmatter.');
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new SkillLibraryError('Invalid Skill frontmatter.');
  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new SkillLibraryError('Skill frontmatter must not contain aliases.');
  }
  if (!isObject(metadata)) {
    throw new SkillLibraryError('Skill frontmatter must be an object.');
  }
  const fields: Record<string, unknown> = metadata;
  if (!isSkillName(fields.name) || fields.name !== directoryName) {
    throw new SkillLibraryError('Skill name must be valid and match its containing directory.');
  }
  if (typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 1024) {
    throw new SkillLibraryError('Skill description must be nonblank text of at most 1024 characters.');
  }
  if (!content.slice(match[0].length).trim()) throw new SkillLibraryError('Skill instructions must not be blank.');
  return { name: fields.name, description: fields.description.trim().replace(/\s*\r?\n\s*/gu, ' ') };
}

async function checkContained(root: string, path: string): Promise<void> {
  const suffix = relative(root, await realpath(path));
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new SkillLibraryError('Skill path resolves outside the discovery root.');
  }
}

function isFileSystemError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

function hasCode(error: unknown, code: string): boolean {
  return isFileSystemError(error) && error.code === code;
}

function errorCode(error: unknown): string {
  return isFileSystemError(error) ? ` (${error.code})` : '';
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
