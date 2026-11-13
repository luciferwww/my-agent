import { describe, expect, it, vi } from 'vitest';
import { SubagentExecutor, mergeContextFilesByName } from './SubagentExecutor.js';
import type { SubagentExecutionRequest } from './SubagentExecutor.js';
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
    const getContextFiles = vi.fn(() => Object.freeze([
      Object.freeze({ path: 'IDENTITY.md', content: 'startup child identity' }),
    ]));
    const executor = new SubagentExecutor({
      agentRunner: { run } as never,
      systemPromptBuilder: { build } as never,
      getContextFiles,
      agentHome: '/agent-home',
      resolveToolPolicy: () => ({
        isDenied: () => true,
        decide: () => 'deny',
      }),
    });
    const signal = new AbortController().signal;
    const approvalCapability = { request: vi.fn() };

    const prepared = await executor.prepare({
      requestId: 'request-1',
      profile: {
        id: 'reviewer',
        description: 'review',
        agentDir: '/missing-profile-dir',
        model: 'inherit',
      },
      description: 'Review code',
      prompt: 'Inspect the patch',
      parentContextFiles: [
        { path: 'IDENTITY.md', content: 'parent identity' },
        { path: 'SOUL.md', content: 'parent soul' },
      ],
      childDepth: 1,
      canSpawn: false,
      childSessionId: '5a848f00-b15f-4a5e-a4cc-3e6aa47342b1',
      childTurnId: 'child-turn',
      maxLlmCallsPerTurn: 9,
      signal,
      toolProjection,
      hookProjection,
      approvalCapability,
      getSessionPermissionMode: () => 'manual',
    });
    await executor.execute(prepared, resolvedModel);

    expect(prepared).toEqual(expect.objectContaining({
      sessionId: '5a848f00-b15f-4a5e-a4cc-3e6aa47342b1',
      subagentDepth: 1,
      turnId: 'child-turn',
      message: 'Inspect the patch',
      maxLlmCalls: 9,
      signal,
    }));
    expect(prepared.systemPrompt).toContain('base');
    expect(prepared.systemPrompt).toContain('Review code');
    expect(getContextFiles).toHaveBeenCalledExactlyOnceWith('reviewer');
    expect(prepared.contextFiles).toEqual([
      { path: 'IDENTITY.md', content: 'startup child identity' },
      { path: 'SOUL.md', content: 'parent soul' },
    ]);
    expect(build).toHaveBeenCalledWith({
      mode: 'minimal',
      contextFiles: prepared.contextFiles,
      toolNames: [],
      agentHome: '/agent-home',
      availableSkills: [],
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
      approvalCapability,
    }));
  });

  it('inherits the Parent effective limit', async () => {
    const executor = new SubagentExecutor({
      agentRunner: { run: vi.fn() } as never,
      systemPromptBuilder: { build: () => 'base' } as never,
      getContextFiles: vi.fn(() => []),
      agentHome: '/agent-home',
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
      maxLlmCallsPerTurn: 6,
      signal: new AbortController().signal,
      toolProjection,
      hookProjection,
      approvalCapability: { request: vi.fn() },
      getSessionPermissionMode: () => 'manual',
    });

    expect(prepared.maxLlmCalls).toBe(6);
  });

  it.each([true, false])('reads the Skills catalog only when the loader is visible: %s', async visible => {
    const summaries = [{ name: 'review', description: 'Review changes.', relativeDirectory: 'review' }];
    const getAvailableSkills = vi.fn(async () => summaries);
    const build = vi.fn(() => 'base');
    const executor = new SubagentExecutor({
      agentRunner: { run: vi.fn() } as never,
      systemPromptBuilder: { build } as never,
      getContextFiles: () => [],
      agentHome: '/agent-home',
      resolveToolPolicy: () => ({
        isDenied: () => !visible,
        decide: () => visible ? 'allow' : 'deny',
      }),
    });
    const request: SubagentExecutionRequest = {
      requestId: 'request',
      profile: { id: 'reviewer', description: 'Review', agentDir: '/agent-home', model: 'inherit' },
      description: 'Review', prompt: 'Review changes', parentContextFiles: [],
      childDepth: 1, canSpawn: false, childSessionId: 'child', childTurnId: 'child-turn',
      signal: new AbortController().signal,
      toolProjection: {
        ...toolProjection,
        visibleDefinitions: () => visible ? [{ name: 'skill', description: 'Load Skill', inputSchema: {} }] : [],
      },
      hookProjection,
      approvalCapability: { request: vi.fn() },
      getSessionPermissionMode: () => 'manual',
      getAvailableSkills,
    };
    await executor.prepare(request);
    expect(getAvailableSkills).toHaveBeenCalledTimes(visible ? 1 : 0);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ availableSkills: visible ? summaries : [] }));
    getAvailableSkills.mockRejectedValueOnce(new Error('Skills root is invalid.'));
    if (visible) await expect(executor.prepare(request)).rejects.toThrow('Skills root is invalid.');
    else await expect(executor.prepare(request)).resolves.toMatchObject({ tools: [] });
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
