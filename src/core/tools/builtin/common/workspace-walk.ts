import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

function normalizeForDisplay(value: string): string {
  return value.split(sep).join('/');
}

export type WorkspaceFileEntry = {
  absolutePath: string;
  relativePath: string;
};

export async function listWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceFileEntry[]> {
  const files: WorkspaceFileEntry[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      files.push({
        absolutePath,
        relativePath: normalizeForDisplay(relative(workspaceRoot, absolutePath)),
      });
    }
  }

  await walk(workspaceRoot);
  return files;
}

export function buildPathMatcher(query: string): (candidate: string) => boolean {
  const normalizedQuery = query.trim().replace(/\\/g, '/');
  if (!normalizedQuery) {
    throw new Error('"query" must be a non-empty string');
  }

  if (!/[*?]/.test(normalizedQuery)) {
    const needle = normalizedQuery.toLowerCase();
    return (candidate) => candidate.toLowerCase().includes(needle);
  }

  const pattern = normalizedQuery
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DOUBLE_STAR::/g, '.*');

  const regex = new RegExp(`^${pattern}$`, 'i');
  return (candidate) => regex.test(candidate);
}