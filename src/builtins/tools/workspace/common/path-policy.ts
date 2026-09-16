import { isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkingDirectoryPathError extends Error {
  readonly inputPath: string;
  readonly workingDir: string;

  constructor(inputPath: string, workingDir: string) {
    super(`Path is outside the working directory: ${inputPath}`);
    this.name = 'WorkingDirectoryPathError';
    this.inputPath = inputPath;
    this.workingDir = workingDir;
  }
}

function normalizeForDisplay(value: string): string {
  return value.split(sep).join('/');
}

function isInsideWorkingDirectory(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveWorkingPath(
  path: unknown,
  workingDir: string,
  workingDirOnly = true,
): {
  workingDir: string;
  resolvedPath: string;
  displayPath: string;
} {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('"path" must be a non-empty string');
  }

  const resolvedRoot = resolve(workingDir);
  const resolvedPath = resolve(resolvedRoot, path);

  if (workingDirOnly && !isInsideWorkingDirectory(resolvedRoot, resolvedPath)) {
    throw new WorkingDirectoryPathError(path, resolvedRoot);
  }

  const rel = relative(resolvedRoot, resolvedPath);
  const inside = isInsideWorkingDirectory(resolvedRoot, resolvedPath);
  return {
    workingDir: resolvedRoot,
    resolvedPath,
    displayPath: inside && rel ? normalizeForDisplay(rel) : inside ? '.' : normalizeForDisplay(resolvedPath),
  };
}
