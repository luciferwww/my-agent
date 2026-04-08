import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Tool, ToolResult } from '../../tools/types.js';
import type { MemoryManager } from '../MemoryManager.js';

/**
 * 创建 memory 工具集，注册到 AgentRunner。
 */
export function createMemoryTools(manager: MemoryManager): Tool[] {
  return [
    createMemorySearchTool(manager),
    createMemoryGetTool(manager),
    createMemoryWriteTool(manager),
  ];
}

// ── memory_search ─────────────────────────────────────────

function createMemorySearchTool(manager: MemoryManager): Tool {
  return {
    name: 'memory_search',
    description:
      'Search your memory for relevant information using semantic similarity and keyword matching.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        maxResults: { type: 'number', description: 'Max results. Default: 6.' },
        minScore: { type: 'number', description: 'Min relevance (0-1). Default: 0.25.' },
      },
      required: ['query'],
    },
    execute: async (params): Promise<ToolResult> => {
      const query = params.query as string;
      const maxResults = params.maxResults as number | undefined;
      const minScore = params.minScore as number | undefined;

      if (!query?.trim()) {
        return { content: 'Error: query must be a non-empty string.', isError: true };
      }

      const results = await manager.search(query, { maxResults, minScore });

      if (results.length === 0) {
        return { content: `No results found for "${query}".` };
      }

      const lines = [`Found ${results.length} result(s) for "${query}":\n`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})`);
        lines.push(r.content);
        lines.push('');
      }

      return { content: lines.join('\n').trim() };
    },
  };
}

// ── memory_get ────────────────────────────────────────────

function createMemoryGetTool(manager: MemoryManager): Tool {
  return {
    name: 'memory_get',
    description: 'Read a memory file, optionally specifying a line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "MEMORY.md" or "memory/2026-04-07.md".' },
        from: { type: 'number', description: 'Start line (1-based). Optional.' },
        lines: { type: 'number', description: 'Number of lines. Optional.' },
      },
      required: ['path'],
    },
    execute: async (params): Promise<ToolResult> => {
      const path = params.path as string;
      const from = params.from as number | undefined;
      const lineCount = params.lines as number | undefined;

      if (!isAllowedReadPath(path)) {
        return { content: `Error: path "${path}" is not allowed. Use "MEMORY.md" or "memory/..." paths.`, isError: true };
      }

      try {
        const content = await manager.readFile(path, from, lineCount);
        return { content };
      } catch (err) {
        return {
          content: `Error reading "${path}": ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// ── memory_write ──────────────────────────────────────────

function createMemoryWriteTool(manager: MemoryManager): Tool {
  return {
    name: 'memory_write',
    description:
      'Save information to memory. Use MEMORY.md for lasting facts, memory/YYYY-MM-DD.md for daily notes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '"MEMORY.md" or "memory/YYYY-MM-DD.md".' },
        content: { type: 'string', description: 'Content to write.' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'Default: append.' },
      },
      required: ['path', 'content'],
    },
    execute: async (params): Promise<ToolResult> => {
      const path = params.path as string;
      const content = params.content as string;
      const mode = (params.mode as 'append' | 'overwrite') ?? 'append';

      if (!isAllowedWritePath(path)) {
        return {
          content: `Error: path "${path}" is not allowed. Use "MEMORY.md" or "memory/YYYY-MM-DD.md".`,
          isError: true,
        };
      }

      try {
        await manager.writeFile(path, content, mode);
        return { content: `Successfully wrote to ${path} (mode: ${mode}).` };
      } catch (err) {
        return {
          content: `Error writing "${path}": ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// ── 路径安全 ──────────────────────────────────────────────

/** memory_get 允许读取 MEMORY.md 和 memory/ 下的文件 */
function isAllowedReadPath(path: string): boolean {
  if (path === 'MEMORY.md') return true;
  if (path.startsWith('memory/') && path.endsWith('.md')) return true;
  return false;
}

/** memory_write 允许写入 MEMORY.md 和 memory/YYYY-MM-DD.md */
function isAllowedWritePath(path: string): boolean {
  if (path === 'MEMORY.md') return true;
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) return true;
  return false;
}
