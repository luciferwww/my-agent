import { describe, expect, it, vi } from 'vitest';
import { SubagentExecutor, mergeContextFilesByName } from './SubagentExecutor.js';
import type { ResolvedModel } from '../model-resolution/index.js';

const resolvedModel = {
  identity: { providerId: 'test', modelId: 'child' },
  referenceSource: 'native',
  protocol: 'test',
  endpointId: 'test',
  invocationPort: {},
  facts: {
    effectiveContextLimit: { value: 1000, source: 'provider-default' },
    maximumOutputTokens: { value: 100, source: 'deployment-config' },
  },
  limits: { maxTokens: 100, maxTokensSource: 'policy-default' },
} as ResolvedModel;

describe('SubagentExecutor', () => {
  it('prepares the isolated Child request and executes only with the supplied ResolvedModel', async () => {
    const run = vi.fn(async () => ({
      text: 'done',
      content: [{ type: 'text' as const, text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 1 },
      toolRounds: 0,
    }));
    const build = vi.fn(() => 'base');
    const loadContextFilesFromDir = vi.fn(async () => []);
    const executor = new SubagentExecutor({
      agentRunner: { run } as never,
      systemPromptBuilder: { build } as never,
      loadContextFilesFromDir,
      workspaceDir: '/workspace',
      promptSafetyLevel: 'normal',
    });
    const signal = new AbortController().signal;

    const prepared = await executor.prepare({
      profile: {
        id: 'reviewer',
        description: 'review',
        agentDir: '/missing-profile-dir',
        model: 'inherit',
        maxLlmCalls: 4,
      },
      description: 'Review code',
      prompt: 'Inspect the patch',
      parentContextFiles: [],
      childDepth: 1,
      canSpawn: false,
      childSessionKey: 'main:subagent:run:1',
      childTurnId: 'child-turn',
      signal,
    });
    await executor.execute(prepared, resolvedModel);

    expect(prepared).toEqual(expect.objectContaining({
      sessionKey: 'main:subagent:run:1',
      turnId: 'child-turn',
      message: 'Inspect the patch',
      maxLlmCalls: 4,
      signal,
    }));
    expect(prepared.systemPrompt).toContain('base');
    expect(prepared.systemPrompt).toContain('Review code');
    expect(loadContextFilesFromDir).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith({
      mode: 'minimal',
      contextFiles: [],
      workspaceDir: '/workspace',
      safetyLevel: 'normal',
    });
    expect(run).toHaveBeenCalledWith({ ...prepared, resolvedModel });
  });

  it('prefers Child context files by path and preserves Parent ordering', () => {
    expect(mergeContextFilesByName(
      [{ path: 'SOUL.md', content: 'child' }],
      [
        { path: 'IDENTITY.md', content: 'parent identity' },
        { path: 'SOUL.md', content: 'parent soul' },
      ],
    )).toEqual([
      { path: 'IDENTITY.md', content: 'parent identity' },
      { path: 'SOUL.md', content: 'child' },
    ]);
  });
});
