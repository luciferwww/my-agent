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
    effectiveContextLimit: 1000,
    maximumOutputTokens: 100,
  },
} as ResolvedModel;

const toolProjection = {
  definitions: [],
  resolve: () => undefined,
  visibleDefinitions: () => [],
};

const hookProjection = {
  beforeToolCall: [],
  afterToolCall: [],
  beforeCompaction: [],
  afterCompaction: [],
};

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
      agentHome: '/agent-home',
      promptSafetyLevel: 'normal',
      resolveToolPolicy: () => ({
        isDenied: () => true,
        decide: () => 'deny',
      }),
    });
    const signal = new AbortController().signal;

    const prepared = await executor.prepare({
      requestId: 'request-1',
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
      childSessionId: '5a848f00-b15f-4a5e-a4cc-3e6aa47342b1',
      childTurnId: 'child-turn',
      parentMaxLlmCalls: 9,
      signal,
      toolProjection,
      hookProjection,
      getSessionPermissionMode: () => 'manual',
    });
    await executor.execute(prepared, resolvedModel);

    expect(prepared).toEqual(expect.objectContaining({
      sessionId: '5a848f00-b15f-4a5e-a4cc-3e6aa47342b1',
      subagentDepth: 1,
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
      toolNames: [],
      agentHome: '/agent-home',
      safetyLevel: 'normal',
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: prepared.sessionId,
      subagentDepth: prepared.subagentDepth,
      turnId: prepared.turnId,
      message: prepared.message,
      systemPrompt: prepared.systemPrompt,
      maxLlmCalls: prepared.maxLlmCalls,
      signal,
      resolvedModel,
      toolProjection: expect.any(Object),
      hookProjection: expect.any(Object),
      toolPolicy: expect.any(Object),
    }));
  });

  it('inherits the Parent limit when the Child profile omits one', async () => {
    const executor = new SubagentExecutor({
      agentRunner: { run: vi.fn() } as never,
      systemPromptBuilder: { build: () => 'base' } as never,
      loadContextFilesFromDir: vi.fn(async () => []),
      agentHome: '/agent-home',
      promptSafetyLevel: 'normal',
      resolveToolPolicy: () => ({
        isDenied: () => true,
        decide: () => 'deny',
      }),
    });

    const prepared = await executor.prepare({
      requestId: 'request-2',
      profile: {
        id: 'reviewer',
        description: 'review',
        agentDir: '/missing-profile-dir',
        model: 'inherit',
      },
      description: 'Review code',
      prompt: 'Inspect the patch',
      parentContextFiles: [],
      childDepth: 1,
      canSpawn: false,
      childSessionId: '5a848f00-b15f-4a5e-a4cc-3e6aa47342b2',
      childTurnId: 'child-turn-2',
      parentMaxLlmCalls: 6,
      signal: new AbortController().signal,
      toolProjection,
      hookProjection,
      getSessionPermissionMode: () => 'manual',
    });

    expect(prepared.maxLlmCalls).toBe(6);
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
