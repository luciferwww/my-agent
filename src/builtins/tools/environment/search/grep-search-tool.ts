import { readFile } from 'node:fs/promises';

import type { Tool } from '../../../../core/tools/types.js';
import { resolveEnvironmentPath } from '../common/path-policy.js';
import { buildPathMatcher, listDirectoryFiles } from '../common/directory-walk.js';

function parsePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`"${fieldName}" must be a positive integer`);
  }

  return value;
}

function buildContentMatcher(query: string, isRegexp: boolean): (line: string) => boolean {
  if (isRegexp) {
    const regex = new RegExp(query, 'i');
    return (line) => regex.test(line);
  }

  const needle = query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

function formatResults(
  query: string,
  isRegexp: boolean,
  matches: Array<{ path: string; lineNumber: number; line: string }>,
): string {
  if (matches.length === 0) {
    return [`query: ${query}`, `isRegexp: ${isRegexp}`, 'matches:', '[no matches]'].join('\n');
  }

  return [
    `query: ${query}`,
    `isRegexp: ${isRegexp}`,
    'matches:',
    ...matches.map((match) => `${match.path}:${match.lineNumber}: ${match.line}`),
  ].join('\n');
}

export function createGrepSearchTool(agentHome: string): Tool {
  return {
    name: 'grep_search',
    description: 'Search files below a selected directory for matching text or regex patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or regex pattern to search for.',
        },
        isRegexp: {
          type: 'boolean',
          description: 'Whether query should be treated as a regular expression.',
        },
        path: {
          type: 'string',
          description: 'Directory to search. Defaults to Agent Home; relative paths resolve from Agent Home.',
        },
        includePattern: {
          type: 'string',
          description: 'Optional glob-like file path filter.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches to return.',
        },
      },
      required: ['query', 'isRegexp'],
    },
    execute: async (params) => {
      try {
        if (typeof params.query !== 'string' || !params.query.trim()) {
          return {
            content: 'Invalid input for tool "grep_search": "query" must be a non-empty string',
            outcome: 'failed',
          };
        }

        if (typeof params.isRegexp !== 'boolean') {
          return {
            content: 'Invalid input for tool "grep_search": "isRegexp" must be a boolean',
            outcome: 'failed',
          };
        }

        const root = resolveEnvironmentPath(params.path ?? '.', agentHome);
        const maxResults = parsePositiveInteger(params.maxResults, 'maxResults');
        const includeMatcher =
          typeof params.includePattern === 'string' && params.includePattern.trim()
            ? buildPathMatcher(params.includePattern)
            : undefined;
        const contentMatcher = buildContentMatcher(params.query, params.isRegexp);
        const files = await listDirectoryFiles(root.resolvedPath);
        const matches: Array<{ path: string; lineNumber: number; line: string }> = [];

        for (const file of files) {
          if (includeMatcher && !includeMatcher(file.relativePath)) {
            continue;
          }

          let content: string;
          try {
            content = await readFile(file.absolutePath, 'utf8');
          } catch {
            continue;
          }

          const lines = content.replace(/\r\n/g, '\n').split('\n');
          if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
          }

          for (let index = 0; index < lines.length; index += 1) {
            if (!contentMatcher(lines[index]!)) {
              continue;
            }

            matches.push({
              path: file.relativePath,
              lineNumber: index + 1,
              line: lines[index]!,
            });

            if (maxResults && matches.length >= maxResults) {
              return {
                outcome: 'success',
                content: formatResults(params.query, params.isRegexp, matches),
              };
            }
          }
        }

        return {
          outcome: 'success',
          content: formatResults(params.query, params.isRegexp, matches),
        };
      } catch (error) {
        return {
          content: `Error executing tool "grep_search": ${error instanceof Error ? error.message : String(error)}`,
          outcome: 'failed',
        };
      }
    },
  };
}
