import { describe, expect, it } from 'vitest';
import type { MemoryManager } from '../core/memory/MemoryManager.js';
import type { Tool } from '../core/tools/types.js';
import {
  assembleRuntimeTools,
  buildTaskToolIfEnabled,
  getDefaultBuiltinTools,
  toLlmToolDefinitions,
  toPromptToolDefinitions,
} from './tool-registry.js';
import type {
  SubagentCapabilities,
  SubagentDelegationPort,
  SubagentProfile,
} from '../core/subagent/types.js';

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
      deny: [],
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
      deny: [],
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

// ── buildTaskToolIfEnabled ──────────────────────────────────

describe('buildTaskToolIfEnabled', () => {
  const dummyProfile: SubagentProfile = {
    id: 'general-purpose',
    description: 'fallback',
    agentDir: '/ws/.agent/subagents/general-purpose',
    model: 'inherit',
  };
  const dummyRegistry = new Map<string, SubagentProfile>([['general-purpose', dummyProfile]]);
  const stubCapabilities = (): SubagentCapabilities => ({
    depth: 0,
    role: 'main',
    canSpawn: true,
  });
  const stubDelegationPort: SubagentDelegationPort = {
    delegate: async () => {
      throw new Error('should not be called by buildTaskToolIfEnabled tests');
    },
  };

  it('returns null when enabled=false', () => {
    const tool = buildTaskToolIfEnabled({
      enabled: false,
      delegationPort: stubDelegationPort,
      profileRegistry: dummyRegistry,
      getCapabilities: stubCapabilities,
      maxDepth: 1,
    });
    expect(tool).toBeNull();
  });

  it('returns a Tool with name="task" when enabled=true', () => {
    const tool = buildTaskToolIfEnabled({
      enabled: true,
      delegationPort: stubDelegationPort,
      profileRegistry: dummyRegistry,
      getCapabilities: stubCapabilities,
      maxDepth: 1,
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe('task');
    expect(typeof tool!.execute).toBe('function');
  });

  it('does NOT leak the "enabled" flag into the resulting Tool', () => {
    const tool = buildTaskToolIfEnabled({
      enabled: true,
      delegationPort: stubDelegationPort,
      profileRegistry: dummyRegistry,
      getCapabilities: stubCapabilities,
      maxDepth: 1,
    });
    expect((tool as unknown as Record<string, unknown>).enabled).toBeUndefined();
  });
});