import { readdir, stat } from 'node:fs/promises';

import type { Tool } from '../types.js';
import { resolveWorkspacePath } from './common/path-policy.js';

function formatDirectoryListing(displayPath: string, entries: Array<{ name: string; type: 'file' | 'dir' }>) {
  if (entries.length === 0) {
    return `path: ${displayPath}\nentries:\n[empty]`;
  }

  return [
    `path: ${displayPath}`,
    'entries:',
    ...entries.map((entry) => (entry.type === 'dir' ? `${entry.name}/` : entry.name)),
  ].join('\n');
}

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List the direct children of a directory inside the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute directory path.',
      },
    },
    required: ['path'],
  },
  execute: async (params) => {
    try {
      const target = resolveWorkspacePath(params.path);
      const targetStat = await stat(target.resolvedPath);
      if (!targetStat.isDirectory()) {
        return {
          content: `Invalid input for tool "list_dir": path is not a directory: ${target.displayPath}`,
          isError: true,
        };
      }

      const entries = await readdir(target.resolvedPath, { withFileTypes: true });
      const normalizedEntries = entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ('dir' as const) : ('file' as const),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        content: formatDirectoryListing(target.displayPath, normalizedEntries),
      };
    } catch (error) {
      return {
        content: `Error executing tool "list_dir": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};