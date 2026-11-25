import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Tool } from '../../../../core/tools/types.js';
import { resolveEnvironmentPath } from '../common/path-policy.js';
import type { FilesystemPolicy } from '../common/filesystem-policy.js';

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

export function createListDirTool(agentHome: string, policy?: FilesystemPolicy): Tool {
  return {
    name: 'list_dir',
    description: 'List the direct children of a selected directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Agent Home-relative or absolute directory path.',
        },
      },
      required: ['path'],
    },
    execute: async (params) => {
      try {
        const target = resolveEnvironmentPath(params.path, agentHome);
        await policy?.assert(target.resolvedPath, 'read');
        const targetStat = await stat(target.resolvedPath);
        if (!targetStat.isDirectory()) {
          return {
            content: `Invalid input for tool "list_dir": path is not a directory: ${target.displayPath}`,
            outcome: 'failed',
          };
        }

        const entries = await readdir(target.resolvedPath, { withFileTypes: true });
        const visible = [];
        for (const entry of entries) {
          if (!policy || await policy.canRead(join(target.resolvedPath, entry.name))) visible.push(entry);
        }
        const normalizedEntries = visible
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? ('dir' as const) : ('file' as const),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));

        return {
          outcome: 'success',
          content: formatDirectoryListing(target.displayPath, normalizedEntries),
        };
      } catch (error) {
        return {
          content: `Error executing tool "list_dir": ${error instanceof Error ? error.message : String(error)}`,
          outcome: 'failed',
        };
      }
    },
  };
}
