import type { Tool } from '../types.js';
import { buildPathMatcher, listWorkspaceFiles } from './common/workspace-walk.js';

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

export const fileSearchTool: Tool = {
  name: 'file_search',
  description: 'Search for files in the workspace by filename or glob-like path pattern.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Substring or glob-like pattern to match file paths.',
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
          isError: true,
        };
      }

      const matcher = buildPathMatcher(params.query);
      const maxResults = parseMaxResults(params.maxResults);
      const files = await listWorkspaceFiles(process.cwd());
      const matches = files
        .map((entry) => entry.relativePath)
        .filter((candidate) => matcher(candidate))
        .slice(0, maxResults);

      return {
        content: formatResults(params.query, matches),
      };
    } catch (error) {
      return {
        content: `Error executing tool "file_search": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};