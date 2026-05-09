import { isAbsolute, relative, resolve, sep } from 'node:path';

function normalizeForDisplay(value: string): string {
  return value.split(sep).join('/');
}

function isInsideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveWorkspacePath(path: unknown, workspaceRoot = process.cwd()): {
  workspaceRoot: string;
  resolvedPath: string;
  displayPath: string;
} {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('"path" must be a non-empty string');
  }

  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(resolvedRoot, path);

  if (!isInsideWorkspace(resolvedRoot, resolvedPath)) {
    throw new Error(`Path is outside the workspace: ${path}`);
  }

  const rel = relative(resolvedRoot, resolvedPath);
  return {
    workspaceRoot: resolvedRoot,
    resolvedPath,
    displayPath: rel ? normalizeForDisplay(rel) : '.',
  };
}