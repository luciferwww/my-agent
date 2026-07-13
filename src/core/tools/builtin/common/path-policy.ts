import { isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkspacePathError extends Error {
  readonly inputPath: string;
  readonly workspaceRoot: string;

  constructor(inputPath: string, workspaceRoot: string) {
    super(`Path is outside the workspace: ${inputPath}`);
    this.name = 'WorkspacePathError';
    this.inputPath = inputPath;
    this.workspaceRoot = workspaceRoot;
  }
}

function normalizeForDisplay(value: string): string {
  return value.split(sep).join('/');
}

function isInsideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveWorkspacePath(
  path: unknown,
  workspaceRoot: string,
  workspaceOnly = true,
): {
  workspaceRoot: string;
  resolvedPath: string;
  displayPath: string;
} {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('"path" must be a non-empty string');
  }

  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(resolvedRoot, path);

  if (workspaceOnly && !isInsideWorkspace(resolvedRoot, resolvedPath)) {
    throw new WorkspacePathError(path, resolvedRoot);
  }

  const rel = relative(resolvedRoot, resolvedPath);
  const inside = isInsideWorkspace(resolvedRoot, resolvedPath);
  return {
    workspaceRoot: resolvedRoot,
    resolvedPath,
    displayPath: inside && rel ? normalizeForDisplay(rel) : inside ? '.' : normalizeForDisplay(resolvedPath),
  };
}
