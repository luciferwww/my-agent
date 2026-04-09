import { describe, expect, it } from 'vitest';
import type { AgentDefaults } from '../config/types.js';
import { buildSystemPromptParams, resolveContextLoadMode } from './prompt-factory.js';

const baseConfig: AgentDefaults = {
  llm: { maxTokens: 4096 },
  runner: { maxToolRounds: 10, maxFollowUpRounds: 5 },
  memory: {
    enabled: false,
    dbPath: '.agent/memory.sqlite',
    embedding: { provider: 'local', model: 'x', dimensions: 384 },
    chunking: { chunkChars: 100, overlapChars: 10 },
    search: { maxResults: 6, minScore: 0.25, vectorWeight: 0.7, textWeight: 0.3 },
  },
  prompt: { mode: 'full', safetyLevel: 'normal' },
  session: { dir: 'sessions' },
  tools: { execTimeout: 30, readMaxLines: 200, webFetchTimeout: 30_000, webFetchMaxChars: 50_000 },
  workspace: { agentDir: '.agent', maxFileChars: 20_000, maxTotalChars: 150_000 },
};

describe('runtime prompt factory', () => {
  it('maps runtime config and per-turn overrides into prompt builder params', () => {
    const params = buildSystemPromptParams({
      config: baseConfig,
      contextFiles: [{ path: 'IDENTITY.md', content: 'identity' }],
      promptDefinitions: [{ name: 'demo_tool', description: 'Demo', parameters: { type: 'object' } }],
      overrides: {
        promptMode: 'minimal',
        safetyLevel: 'strict',
      },
    });

    expect(params.mode).toBe('minimal');
    expect(params.safetyLevel).toBe('strict');
    expect(params.contextFiles).toHaveLength(1);
    expect(params.tools).toHaveLength(1);
  });

  it('keeps a full context cache when prompt mode is none', () => {
    expect(resolveContextLoadMode('none')).toBe('full');
    expect(resolveContextLoadMode('minimal')).toBe('minimal');
  });
});