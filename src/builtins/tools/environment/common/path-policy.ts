import { isAbsolute, relative, resolve, sep } from 'node:path';

function normalizeForDisplay(value: string): string {
  return value.split(sep).join('/');
}

export function resolveEnvironmentPath(
  path: unknown,
  agentHome: string,
): {
  agentHome: string;
  resolvedPath: string;
  displayPath: string;
} {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('"path" must be a non-empty string');
  }

  const resolvedRoot = resolve(agentHome);
  const resolvedPath = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, resolvedPath);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  return {
    agentHome: resolvedRoot,
    resolvedPath,
    displayPath: inside && rel ? normalizeForDisplay(rel) : inside ? '.' : normalizeForDisplay(resolvedPath),
  };
}
