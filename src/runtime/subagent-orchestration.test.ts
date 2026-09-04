import { describe, it, expect, vi } from 'vitest';
import {
  createSubagentHostBindings,
  runSubagentTurn,
  addUsage,
  type CreateSubagentHostBindingsParams,
} from './subagent-orchestration.js';
import type { AgentDefaults } from '../platform/config/types.js';
import type { ContextFile } from '../core/workspace/types.js';
import type {
  SubagentProfile,
  SubagentRunInput,
  SubagentRunResult,
  SubagentRunRequest,
} from '../core/subagent/types.js';
import type { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import type { MessageRouteContext } from './queue-types.js';

// ── Fixtures ────────────────────────────────────────────────

function profile(id: string, overrides: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id,
    description: `${id} subagent`,
    agentDir: `/ws/.agent/subagents/${id}`,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<AgentDefaults>): AgentDefaults {
  const base: AgentDefaults = {
    llm: {
      model: 'claude-default',
      maxTokens: 4096,
      contextWindowTokens: 200_000,
    },
    runner: { maxLlmCalls: 12, inTurnMessageMode: 'followup' },
    memory: {
      enabled: false,
      embedding: { provider: 'local', model: 'x' },
      chunking: { chunkChars: 100, overlapChars: 10 },
      search: { maxResults: 6, minScore: 0.25, vectorWeight: 0.7, textWeight: 0.3 },
    },
    prompt: { safetyLevel: 'normal' },
    tools: {
      fs: { workspaceOnly: true },
      allow: ['read_file', 'grep_search'],
      deny: ['rm'],
    },
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
    subagents: { enabled: true, maxDepth: 2 },
  };
  return { ...base, ...overrides };
}

function makeRouteContext(
  channelId: string,
  clientId?: string,
): MessageRouteContext {
  return {
    originChannel: { id: channelId } as unknown as MessageRouteContext['originChannel'],
    originClientId: clientId,
  };
}

// ── createSubagentHostBindings ───────────────────────────────

describe('createSubagentHostBindings', () => {
  function buildParams(
    overrides: Partial<CreateSubagentHostBindingsParams> = {},
  ): CreateSubagentHostBindingsParams {
    return {
      getParentContextFiles: () => [],
      routeContextByTurn: new Map(),
      resolvedConfig: makeConfig(),
      resolveLegacyChildModel: vi.fn(() => {
        throw new Error('Not used by host projection tests.');
      }),
      workspaceDir: '/work/space',
      ...overrides,
    };
  }

  // ── projection of resolvedConfig snapshot ─────────────────

  it('projects mainAgentTools allow/deny from resolvedConfig.tools', () => {
    const host = createSubagentHostBindings(buildParams());
    expect(host.mainAgentTools.allow).toEqual(['read_file', 'grep_search']);
    expect(host.mainAgentTools.deny).toEqual(['rm']);
  });

  it('falls back to empty arrays when resolvedConfig.tools is undefined', () => {
    const host = createSubagentHostBindings(
      buildParams({ resolvedConfig: makeConfig({ tools: undefined as never }) }),
    );
    expect(host.mainAgentTools.allow).toEqual([]);
    expect(host.mainAgentTools.deny).toEqual([]);
  });

  it('forwards the one-way legacy Child resolver', () => {
    const resolveLegacyChildModel = vi.fn(() => {
      throw new Error('Not invoked by this test.');
    });
    const host = createSubagentHostBindings(buildParams({ resolveLegacyChildModel }));
    expect(host.resolveLegacyChildModel).toBe(resolveLegacyChildModel);
  });

  it('uses workspaceDir verbatim', () => {
    const host = createSubagentHostBindings(buildParams({ workspaceDir: '/abs/path' }));
    expect(host.workspaceDir).toBe('/abs/path');
  });

  it('uses subagents.maxDepth from resolvedConfig (default 1 when omitted)', () => {
    const withDepth = createSubagentHostBindings(
      buildParams({ resolvedConfig: makeConfig({ subagents: { enabled: true, maxDepth: 3 } }) }),
    );
    expect(withDepth.maxDepth).toBe(3);

    const noSubagentsBlock = createSubagentHostBindings(
      buildParams({ resolvedConfig: makeConfig({ subagents: undefined }) }),
    );
    expect(noSubagentsBlock.maxDepth).toBe(1);
  });

  it('passes promptSafetyLevel through (defaults to "normal")', () => {
    const strict = createSubagentHostBindings(
      buildParams({
        resolvedConfig: makeConfig({ prompt: { safetyLevel: 'strict' } }),
      }),
    );
    expect(strict.promptSafetyLevel).toBe('strict');

    const fallback = createSubagentHostBindings(
      buildParams({ resolvedConfig: makeConfig({ prompt: undefined as never }) }),
    );
    expect(fallback.promptSafetyLevel).toBe('normal');
  });

  // ── (d) registerTurnContext ───────────────────────────────

  describe('(d) registerTurnContext', () => {
    it('copies the parent route context onto the child turnId when present', () => {
      const route = new Map<string, MessageRouteContext>();
      const parentCtx = makeRouteContext('cli-1', 'client-A');
      route.set('parent-turn', parentCtx);

      const host = createSubagentHostBindings(
        buildParams({ routeContextByTurn: route }),
      );
      host.registerTurnContext('child-turn', 'parent-turn');

      expect(route.get('child-turn')).toBe(parentCtx);
    });

    it('does NOT throw when the parent route context is missing', () => {
      const route = new Map<string, MessageRouteContext>();
      const host = createSubagentHostBindings(
        buildParams({ routeContextByTurn: route }),
      );
      expect(() => host.registerTurnContext('child-turn', 'unknown-parent')).not.toThrow();
      expect(route.has('child-turn')).toBe(false);
    });
  });

  // ── (e) releaseTurnContext ────────────────────────────────

  describe('(e) releaseTurnContext', () => {
    it('removes the entry for the child turnId', () => {
      const route = new Map<string, MessageRouteContext>();
      const ctx = makeRouteContext('cli-1');
      route.set('child-turn', ctx);

      const host = createSubagentHostBindings(
        buildParams({ routeContextByTurn: route }),
      );
      host.releaseTurnContext('child-turn');
      expect(route.has('child-turn')).toBe(false);
    });

    it('is a no-op when the turnId is not present', () => {
      const route = new Map<string, MessageRouteContext>();
      const host = createSubagentHostBindings(
        buildParams({ routeContextByTurn: route }),
      );
      expect(() => host.releaseTurnContext('missing-turn')).not.toThrow();
    });
  });

  // ── (f) getParentContextFiles is a live getter ────────────

  describe('(f) getParentContextFiles', () => {
    it('returns whatever the getter returns at call time (sees later replacements)', () => {
      const slot: { files: ContextFile[] } = {
        files: [{ path: 'IDENTITY.md', content: 'v1' }],
      };
      const host = createSubagentHostBindings(
        buildParams({ getParentContextFiles: () => slot.files }),
      );
      expect(host.getParentContextFiles()).toEqual([{ path: 'IDENTITY.md', content: 'v1' }]);

      slot.files = [{ path: 'IDENTITY.md', content: 'v2' }];
      expect(host.getParentContextFiles()).toEqual([{ path: 'IDENTITY.md', content: 'v2' }]);
    });
  });
});

// ── runSubagentTurn ─────────────────────────────────────────

describe('runSubagentTurn', () => {
  function makeDeps(opts: {
    registry?: Map<string, SubagentProfile>;
    runResult?: SubagentRunResult;
  } = {}) {
    const registry =
      opts.registry ??
      new Map<string, SubagentProfile>([
        ['general-purpose', profile('general-purpose')],
        ['reviewer', profile('reviewer')],
      ]);
    const runResult =
      opts.runResult ??
      ({
        runId: 'run-1',
        sessionKey: 'library:subagent:run-1:1',
        turnId: 'child-turn',
        text: 'done',
        outcome: 'ok',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 100,
      } satisfies SubagentRunResult);

    const run = vi.fn(async (_req: SubagentRunRequest) => runResult);
    const subagentRunner = { run } as unknown as SubagentRunner;

    return { run, subagentRunner, profileRegistry: registry };
  }

  function makeInput(overrides: Partial<SubagentRunInput> = {}): SubagentRunInput {
    return {
      subagentType: 'reviewer',
      description: 'review code',
      prompt: 'please review',
      trigger: { source: 'library', callerLabel: 'integration-test' },
      lifecycle: 'blocking',
      ...overrides,
    };
  }

  // (c) unknown profile → fail-fast

  it('(c) throws when subagentType is not registered (library API fail-fast)', async () => {
    const { subagentRunner, profileRegistry, run } = makeDeps();
    await expect(
      runSubagentTurn(makeInput({ subagentType: 'nonexistent' }), {
        subagentRunner,
        profileRegistry,
      }),
    ).rejects.toThrow(/Unknown subagent type/);
    expect(run).not.toHaveBeenCalled();
  });

  it('(c-contrast) LLM tool fallback wording does NOT leak: error mentions "library API"', async () => {
    const { subagentRunner, profileRegistry } = makeDeps();
    await expect(
      runSubagentTurn(makeInput({ subagentType: 'nonexistent' }), {
        subagentRunner,
        profileRegistry,
      }),
    ).rejects.toThrow(/library API/i);
  });

  // library trigger synthesizes parent identifiers

  it('synthesizes parentSessionKey from callerLabel for library trigger', async () => {
    const { subagentRunner, profileRegistry, run } = makeDeps();
    await runSubagentTurn(
      makeInput({ trigger: { source: 'library', callerLabel: 'integration-test' } }),
      { subagentRunner, profileRegistry },
    );
    const req = run.mock.calls[0]![0];
    expect(req.parentSessionKey).toBe('integration-test');
    expect(req.parentTurnId).toBe('library-synthetic-integration-test');
  });

  it('falls back to "library" / "library-synthetic-caller" when callerLabel is omitted', async () => {
    const { subagentRunner, profileRegistry, run } = makeDeps();
    await runSubagentTurn(makeInput({ trigger: { source: 'library' } }), {
      subagentRunner,
      profileRegistry,
    });
    const req = run.mock.calls[0]![0];
    expect(req.parentSessionKey).toBe('library');
    expect(req.parentTurnId).toBe('library-synthetic-caller');
  });

  // llm-tool trigger preserves identifiers

  it('uses parentSessionKey / parentTurnId from llm-tool trigger verbatim', async () => {
    const { subagentRunner, profileRegistry, run } = makeDeps();
    await runSubagentTurn(
      makeInput({
        trigger: {
          source: 'llm-tool',
          parentSessionKey: 'main',
          parentTurnId: 'turn-7',
          parentToolUseId: 'tu-99',
        },
      }),
      { subagentRunner, profileRegistry },
    );
    const req = run.mock.calls[0]![0];
    expect(req.parentSessionKey).toBe('main');
    expect(req.parentTurnId).toBe('turn-7');
  });

  // forwards description / prompt / lifecycle / signal

  it('forwards description / prompt / lifecycle / signal verbatim', async () => {
    const { subagentRunner, profileRegistry, run } = makeDeps();
    const signal = new AbortController().signal;
    await runSubagentTurn(
      makeInput({
        description: 'd',
        prompt: 'p',
        lifecycle: 'blocking',
        signal,
      }),
      { subagentRunner, profileRegistry },
    );
    const req = run.mock.calls[0]![0];
    expect(req.description).toBe('d');
    expect(req.prompt).toBe('p');
    expect(req.lifecycle).toBe('blocking');
    expect(req.signal).toBe(signal);
  });

  it('passes the resolved profile (by id) into the runner', async () => {
    const { subagentRunner, profileRegistry, run } = makeDeps();
    await runSubagentTurn(makeInput({ subagentType: 'reviewer' }), {
      subagentRunner,
      profileRegistry,
    });
    expect(run.mock.calls[0]![0].profile.id).toBe('reviewer');
  });
});

// ── addUsage ────────────────────────────────────────────────

describe('addUsage', () => {
  it('component-wise adds two TokenUsage values', () => {
    expect(
      addUsage(
        { inputTokens: 10, outputTokens: 5 },
        { inputTokens: 3, outputTokens: 7 },
      ),
    ).toEqual({ inputTokens: 13, outputTokens: 12 });
  });

  it('(a) parent + child usage tree accumulation works for the happy path', () => {
    const parent = { inputTokens: 100, outputTokens: 50 };
    const child = { inputTokens: 80, outputTokens: 40 };
    expect(addUsage(parent, child)).toEqual({ inputTokens: 180, outputTokens: 90 });
  });

  it('(b) child usage={0,0} does not pollute the parent (error path per spec §13.2)', () => {
    const parent = { inputTokens: 100, outputTokens: 50 };
    const child = { inputTokens: 0, outputTokens: 0 };
    expect(addUsage(parent, child)).toEqual(parent);
  });
});
