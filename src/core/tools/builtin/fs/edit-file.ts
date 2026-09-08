import { readFile, writeFile } from 'node:fs/promises';

import type { Tool } from '../../types.js';
import { resolveWorkspacePath } from '../common/path-policy.js';

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

function formatEditResult(path: string, replacements: number): string {
  return [`path: ${path}`, `replacements: ${replacements}`].join('\n');
}

export function createEditFileTool(workspaceDir: string, workspaceOnly = true): Tool {
  return {
    name: 'edit_file',
    description: 'Replace one exact text occurrence in a workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        oldText: {
          type: 'string',
          description: 'Exact text to replace. Must appear exactly once.',
        },
        newText: {
          type: 'string',
          description: 'Replacement text.',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
    execute: async (params) => {
      try {
        if (typeof params.oldText !== 'string' || params.oldText.length === 0) {
          return {
            content: 'Invalid input for tool "edit_file": "oldText" must be a non-empty string',
            outcome: 'failed',
          };
        }

        if (typeof params.newText !== 'string') {
          return {
            content: 'Invalid input for tool "edit_file": "newText" must be a string',
            outcome: 'failed',
          };
        }

        const target = resolveWorkspacePath(params.path, workspaceDir, workspaceOnly);
        const original = await readFile(target.resolvedPath, 'utf8');
        const occurrences = countOccurrences(original, params.oldText);

        if (occurrences === 0) {
          return {
            content: `Error executing tool "edit_file": oldText not found in ${target.displayPath}`,
            outcome: 'failed',
          };
        }

        if (occurrences > 1) {
          return {
            content: `Error executing tool "edit_file": oldText matched ${occurrences} times in ${target.displayPath}`,
            outcome: 'failed',
          };
        }

        const updated = original.replace(params.oldText, params.newText);
        await writeFile(target.resolvedPath, updated, 'utf8');

        return {
          outcome: 'success',
          content: formatEditResult(target.displayPath, 1),
        };
      } catch (error) {
        return {
          content: `Error executing tool "edit_file": ${error instanceof Error ? error.message : String(error)}`,
          outcome: 'failed',
        };
      }
    },
  };
}
