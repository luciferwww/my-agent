import type { Tool } from '../../../../core/tools/types.js';
import { resolveEnvironmentPath } from '../common/path-policy.js';
import { buildPathMatcher, listDirectoryFiles } from '../common/directory-walk.js';

function parseMaxResults(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error('"maxResults" must be a positive integer');
  }

  return value;
}

function formatResults(query: string, matches: string[]): string {
  if (matches.length === 0) {
    return `query: ${query}\nmatches:\n[no matches]`;
  }

  return [`query: ${query}`, 'matches:', ...matches].join('\n');
}

export function createFileSearchTool(agentHome: string): Tool {
  return {
    name: 'file_search',
    description: 'Search for files below a selected directory by filename or glob-like path pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring or glob-like pattern to match file paths.',
        },
        path: {
          type: 'string',
          description: 'Directory to search. Defaults to Agent Home; relative paths resolve from Agent Home.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches to return.',
        },
      },
      required: ['query'],
    },
    execute: async (params) => {
      try {
        if (typeof params.query !== 'string' || !params.query.trim()) {
          return {
            content: 'Invalid input for tool "file_search": "query" must be a non-empty string',
            outcome: 'failed',
          };
        }

        const root = resolveEnvironmentPath(params.path ?? '.', agentHome);
        const matcher = buildPathMatcher(params.query);
        const maxResults = parseMaxResults(params.maxResults);
        const files = await listDirectoryFiles(root.resolvedPath);
        const matches = files
          .map((entry) => entry.relativePath)
          .filter((candidate) => matcher(candidate))
          .slice(0, maxResults);

        return {
          outcome: 'success',
          content: formatResults(params.query, matches),
        };
      } catch (error) {
        return {
          content: `Error executing tool "file_search": ${error instanceof Error ? error.message : String(error)}`,
          outcome: 'failed',
        };
      }
    },
  };
}
