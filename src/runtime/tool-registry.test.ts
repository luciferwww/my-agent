import { describe, expect, it } from 'vitest';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { Tool } from '../tools/types.js';
import {
  assembleRuntimeTools,
  getDefaultBuiltinTools,
  toLlmToolDefinitions,
  toPromptToolDefinitions,
} from './tool-registry.js';

describe('runtime tool registry', () => {
  it('converts tools into llm and prompt definitions from the same source list', () => {
    const tools: Tool[] = [
      {
        name: 'demo_tool',
        description: 'Demo',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        async execute() {
          return { content: 'ok' };
        },
      },
    ];

    const llmDefinitions = toLlmToolDefinitions(tools);
    const promptDefinitions = toPromptToolDefinitions(tools);

    expect(llmDefinitions).toEqual([
      {
        name: 'demo_tool',
        description: 'Demo',
        input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ]);
    expect(promptDefinitions).toEqual([
      {
        name: 'demo_tool',
        description: 'Demo',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ]);
  });

  it('injects memory tools only when a memory manager exists', () => {
    const builtinTools: Tool[] = [
      {
        name: 'demo_tool',
        description: 'Demo',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          return { content: 'ok' };
        },
      },
    ];

    const bundleWithoutMemory = assembleRuntimeTools({
      builtinTools,
      memoryManager: null,
    });
    const bundleWithMemory = assembleRuntimeTools({
      builtinTools,
      memoryManager: {
        search: async () => [],
        readFile: async () => '',
        writeFile: async () => {},
        reindex: async () => {},
        close: () => {},
      } as unknown as MemoryManager,
    });

    expect(bundleWithoutMemory.tools.map((tool) => tool.name)).toEqual(['demo_tool']);
    expect(bundleWithMemory.tools.map((tool) => tool.name)).toEqual([
      'demo_tool',
      'memory_search',
      'memory_get',
      'memory_write',
    ]);
  });

  it('filters optional builtin tools via runtime options', () => {
    const tools = getDefaultBuiltinTools({
      workspaceDir: 'workspace',
      webFetchEnabled: false,
      execEnabled: false,
      processEnabled: false,
    });

    expect(tools.map((tool) => tool.name)).not.toContain('web_fetch');
    expect(tools.map((tool) => tool.name)).not.toContain('exec');
    expect(tools.map((tool) => tool.name)).not.toContain('process');
  });
});