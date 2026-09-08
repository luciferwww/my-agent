import { describe, expect, it } from 'vitest';
import type { AgentDefaults } from '../platform/config/types.js';
import { buildSystemPromptParams, resolveContextLoadMode } from './prompt-factory.js';

const baseConfig: AgentDefaults = {
  llm: { maxTokens: 4096, contextWindowTokens: 200_000 },
  runner: { maxLlmCalls: 12, inTurnMessageMode: 'followup' },
  memory: {
    enabled: false,
    embedding: { provider: 'local', model: 'x' },
    chunking: { chunkChars: 100, overlapChars: 10 },
    search: { maxResults: 6, minScore: 0.25, vectorWeight: 0.7, textWeight: 0.3 },
  },
  prompt: { safetyLevel: 'normal' },
  tools: { fs: { workspaceOnly: true }, allow: [], deny: [] },
  workspace: { maxFileChars: 20_000, maxTotalChars: 150_000 },
  compaction: {
    enabled: true,
    reserveTokens: 20_000,
    keepRecentTurns: 3,
    toolResultContextShare: 0.5,
    toolResultHeadChars: 10_000,
    toolResultTailChars: 5_000,
    timeoutSeconds: 300,
  },
};

describe('runtime prompt factory', () => {
  it('maps runtime config and per-turn overrides into prompt builder params', () => {
    const params = buildSystemPromptParams({
      config: baseConfig,
      contextFiles: [{ path: 'IDENTITY.md', content: 'identity' }],
      toolNames: ['demo_tool'],
      overrides: {
        promptMode: 'minimal',
        safetyLevel: 'strict',
      },
    });

    expect(params.mode).toBe('minimal');
    expect(params.safetyLevel).toBe('strict');
    expect(params.contextFiles).toHaveLength(1);
    expect(params.toolNames).toEqual(['demo_tool']);
  });

  it('threads workspaceDir into the SystemPromptBuildParams', () => {
    const params = buildSystemPromptParams({
      config: baseConfig,
      contextFiles: [],
      toolNames: [],
      overrides: { promptMode: 'full' },
      workspaceDir: '/work/space',
    });
    expect(params.workspaceDir).toBe('/work/space');
  });

  it('threads availableSubagents into the SystemPromptBuildParams', () => {
    const params = buildSystemPromptParams({
      config: baseConfig,
      contextFiles: [],
      toolNames: [],
      overrides: { promptMode: 'full' },
      availableSubagents: [
        { id: 'general-purpose', description: 'fallback' },
        { id: 'reviewer', description: 'review' },
      ],
    });
    expect(params.availableSubagents).toEqual([
      { id: 'general-purpose', description: 'fallback' },
      { id: 'reviewer', description: 'review' },
    ]);
  });

  it('leaves workspaceDir / availableSubagents undefined when caller omits them', () => {
    const params = buildSystemPromptParams({
      config: baseConfig,
      contextFiles: [],
      toolNames: [],
      overrides: { promptMode: 'full' },
    });
    expect(params.workspaceDir).toBeUndefined();
    expect(params.availableSubagents).toBeUndefined();
  });

  it('keeps a full context cache when prompt mode is none', () => {
    expect(resolveContextLoadMode('none')).toBe('full');
    expect(resolveContextLoadMode('minimal')).toBe('minimal');
  });
});