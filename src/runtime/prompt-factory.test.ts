import { describe, expect, it } from 'vitest';
import { buildSystemPromptParams, resolveContextLoadMode } from './prompt-factory.js';

describe('runtime prompt factory', () => {
  it('maps per-turn mode and runtime inputs into prompt builder params', () => {
    const params = buildSystemPromptParams({
      contextFiles: [{ path: 'IDENTITY.md', content: 'identity' }],
      toolNames: ['demo_tool'],
      overrides: {
        promptMode: 'minimal',
      },
    });

    expect(params.mode).toBe('minimal');
    expect(params.contextFiles).toHaveLength(1);
    expect(params.toolNames).toEqual(['demo_tool']);
  });

  it('threads agentHome into the SystemPromptBuildParams', () => {
    const params = buildSystemPromptParams({
      contextFiles: [],
      toolNames: [],
      overrides: { promptMode: 'full' },
      agentHome: '/agent/home',
    });
    expect(params.agentHome).toBe('/agent/home');
  });

  it('threads availableSubagents into the SystemPromptBuildParams', () => {
    const params = buildSystemPromptParams({
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

  it('leaves agentHome / availableSubagents undefined when caller omits them', () => {
    const params = buildSystemPromptParams({
      contextFiles: [],
      toolNames: [],
      overrides: { promptMode: 'full' },
    });
    expect(params.agentHome).toBeUndefined();
    expect(params.availableSubagents).toBeUndefined();
  });

  it('keeps a full context cache when prompt mode is none', () => {
    expect(resolveContextLoadMode('none')).toBe('full');
    expect(resolveContextLoadMode('minimal')).toBe('minimal');
  });
});