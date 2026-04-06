import { readFile, stat } from 'node:fs/promises';

import type { Tool } from '../types.js';
import { resolveWorkspacePath } from './common/path-policy.js';

const DEFAULT_MAX_LINES = 200;

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`"${fieldName}" must be a positive integer`);
  }

  return value;
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function formatReadResult(params: {
  displayPath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  selectedLines: string[];
  truncated: boolean;
}): string {
  const header = [
    `path: ${params.displayPath}`,
    `lines: ${params.startLine}-${params.endLine} of ${params.totalLines}`,
    ...(params.truncated ? ['truncated: true'] : []),
  ];

  return `${header.join('\n')}\n\n${params.selectedLines.join('\n')}`.trimEnd();
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read file contents from the workspace, optionally limited to a 1-based line range.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute file path.',
      },
      startLine: {
        type: 'number',
        description: '1-based start line.',
      },
      endLine: {
        type: 'number',
        description: '1-based end line, inclusive.',
      },
    },
    required: ['path'],
  },
  execute: async (params) => {
    try {
      const target = resolveWorkspacePath(params.path);
      const startLine = normalizePositiveInteger(params.startLine, 'startLine');
      const endLine = normalizePositiveInteger(params.endLine, 'endLine');

      if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
        return {
          content: 'Invalid input for tool "read_file": "startLine" must be less than or equal to "endLine"',
          isError: true,
        };
      }

      const targetStat = await stat(target.resolvedPath);
      if (!targetStat.isFile()) {
        return {
          content: `Invalid input for tool "read_file": path is not a file: ${target.displayPath}`,
          isError: true,
        };
      }

      const raw = await readFile(target.resolvedPath, 'utf8');
      const lines = splitLines(raw);
      const totalLines = lines.length;

      if (totalLines === 0) {
        return {
          content: `path: ${target.displayPath}\nlines: 0\n\n[empty file]`,
        };
      }

      const effectiveStart = startLine ?? 1;
      const requestedEnd = endLine ?? (startLine ? totalLines : DEFAULT_MAX_LINES);
      const effectiveEnd = Math.min(requestedEnd, totalLines);

      if (effectiveStart > totalLines) {
        return {
          content: `Invalid input for tool "read_file": startLine ${effectiveStart} exceeds file length ${totalLines}`,
          isError: true,
        };
      }

      const selectedLines = lines.slice(effectiveStart - 1, effectiveEnd);
      return {
        content: formatReadResult({
          displayPath: target.displayPath,
          startLine: effectiveStart,
          endLine: effectiveEnd,
          totalLines,
          selectedLines,
          truncated: startLine === undefined && endLine === undefined && totalLines > DEFAULT_MAX_LINES,
        }),
      };
    } catch (error) {
      return {
        content: `Error executing tool "read_file": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};