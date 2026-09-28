import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Tool } from '../../../../core/tools/types.js';
import { resolveEnvironmentPath } from '../common/path-policy.js';

function formatWriteResult(params: { path: string; created: boolean; bytesWritten: number }): string {
  return [
    `path: ${params.path}`,
    `created: ${params.created}`,
    `bytesWritten: ${params.bytesWritten}`,
  ].join('\n');
}

export function createWriteFileTool(agentHome: string): Tool {
  return {
    name: 'write_file',
    description:
      'Create a new file or intentionally replace an existing file in full. '
      + 'For localized changes to an existing file, prefer edit_file for one exact replacement '
      + 'or apply_patch for multiple edits so unrelated content is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Agent Home-relative or absolute file path.',
        },
        content: {
          type: 'string',
          description: 'Complete replacement content. Existing content is discarded in full.',
        },
      },
      required: ['path', 'content'],
    },
    execute: async (params) => {
      try {
        if (typeof params.content !== 'string') {
          return {
            content: 'Invalid input for tool "write_file": "content" must be a string',
            outcome: 'failed',
          };
        }

        const target = resolveEnvironmentPath(params.path, agentHome);
        let created = false;

        try {
          await readFile(target.resolvedPath, 'utf8');
        } catch {
          created = true;
        }

        await mkdir(dirname(target.resolvedPath), { recursive: true });
        await writeFile(target.resolvedPath, params.content, 'utf8');

        return {
          outcome: 'success',
          content: formatWriteResult({
            path: target.displayPath,
            created,
            bytesWritten: Buffer.byteLength(params.content, 'utf8'),
          }),
        };
      } catch (error) {
        return {
          content: `Error executing tool "write_file": ${error instanceof Error ? error.message : String(error)}`,
          outcome: 'failed',
        };
      }
    },
  };
}
