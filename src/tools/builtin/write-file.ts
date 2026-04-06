import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Tool } from '../types.js';
import { resolveWorkspacePath } from './common/path-policy.js';

function formatWriteResult(params: { path: string; created: boolean; bytesWritten: number }): string {
  return [
    `path: ${params.path}`,
    `created: ${params.created}`,
    `bytesWritten: ${params.bytesWritten}`,
  ].join('\n');
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a file inside the workspace with the provided full content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute file path.',
      },
      content: {
        type: 'string',
        description: 'Full file content to write.',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (params) => {
    try {
      if (typeof params.content !== 'string') {
        return {
          content: 'Invalid input for tool "write_file": "content" must be a string',
          isError: true,
        };
      }

      const target = resolveWorkspacePath(params.path);
      let created = false;

      try {
        await readFile(target.resolvedPath, 'utf8');
      } catch {
        created = true;
      }

      await mkdir(dirname(target.resolvedPath), { recursive: true });
      await writeFile(target.resolvedPath, params.content, 'utf8');

      return {
        content: formatWriteResult({
          path: target.displayPath,
          created,
          bytesWritten: Buffer.byteLength(params.content, 'utf8'),
        }),
      };
    } catch (error) {
      return {
        content: `Error executing tool "write_file": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};