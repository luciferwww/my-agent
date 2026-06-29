import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubagentRunner } from './SubagentRunner.js';
import { getSubagentDepth } from './session-key.js';
import type {
  SubagentHostBindings,
  SubagentProfile,
  SubagentRunRequest,
  SubagentRunnerDeps,
} from './types.js';
import type { ContextFile } from '../workspace/types.js';
import type { AgentEvent, RunParams, RunResult } from '../runner/types.js';

// ── Fixtures ────────────────────────────────────────────────

const MAIN_SESSION = 'main';
const PARENT_TURN = 'parent-turn-1';
const PARENT_TOOL_USE = 'tu-parent-1';

const TRIGGER = {
  source: 'llm-tool' as const,
  parentSessionKey: MAIN_SESSION,
  parentTurnId: PARENT_TURN,
  parentToolUseId: PARENT_TOOL_USE,
};

const PARENT_FILES: ContextFile[] = [
  { path: 'IDENTITY.md', content: 'parent-identity' },
  { path: 'SOUL.md', content: 'parent-soul' },
  { path: 'AGENTS.md', content: 'parent-agents' },
  { path: 'TOOLS.md', content: 'parent-tools' },
];

const LLM_DEFAULTS = {
  model: 'host-default-model',
  maxTokens: 4096,
  contextWindowTokens: 200_000,
};

function makeProfile(overrides: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id: 'reviewer',
    description: 'review code',
    agentDir: '/intentionally-missing-dir',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<SubagentRunRequest> = {}): SubagentRunRequest {
  return {
    profile: makeProfile(),
    description: 'audit changes',
    prompt: 'please look at PR #42',
    trigger: TRIGGER,
    lifecycle: 'blocking',
    parentSessionKey: MAIN_SESSION,
    parentTurnId: PARENT_TURN,
    ...overrides,
  };
}

interface BuildHostOpts {
  maxDepth?: number;
  parentContextFiles?: ContextFile[];
  workspaceDir?: string;
  promptSafetyLevel?: 'relaxed' | 'normal' | 'strict';
}

function makeHost(opts: BuildHostOpts = {}) {
  const register = vi.fn();
  const release = vi.fn();
  const getParent = vi.fn(() => opts.parentContextFiles ?? PARENT_FILES);
  const host: SubagentHostBindings = {
    registerTurnContext: register,
    releaseTurnContext: release,
    getParentContextFiles: getParent,
    mainAgentTools: { allow: [], deny: [] },
    llmDefaults: LLM_DEFAULTS,
    maxDepth: opts.maxDepth ?? 2,
    workspaceDir: opts.workspaceDir ?? '/ws',
    promptSafetyLevel: opts.promptSafetyLevel ?? 'normal',
  };
  return { host, register, release, getParent };
}

interface BuildDepsOpts {
  agentRunnerRun?: (params: RunParams) => Promise<RunResult>;
  childFiles?: ContextFile[];
  /**
   * If true the loader is wired but a SubagentRunner instance is expected to
   * SKIP it because `profile.agentDir` does not exist on disk. Useful for
   * asserting fallback behavior.
   */
  loader?: (absDir: string) => Promise<ContextFile[]>;
  promptBuilderBuild?: (params: unknown) => string;
  sessionManagerDelete?: (key: string) => Promise<void>;
  host?: SubagentHostBindings;
  onEvent?: (e: AgentEvent) => void;
}

function makeDeps(opts: BuildDepsOpts = {}) {
  const events: AgentEvent[] = [];
  const onEvent = opts.onEvent ?? ((e: AgentEvent) => events.push(e));
  const agentRunnerRun =
    opts.agentRunnerRun ??
    (async (_params: RunParams): Promise<RunResult> => ({
      text: 'subagent-final-answer',
      content: [{ type: 'text', text: 'subagent-final-answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      toolRounds: 0,
    }));

  const agentRunner = { run: vi.fn(agentRunnerRun) };
  const sessionManagerDelete = vi.fn(
    opts.sessionManagerDelete ?? (async (_key: string) => {}),
  );
  const sessionManager = { deleteSession: sessionManagerDelete };

  const loader = vi.fn(
    opts.loader ?? (async (_absDir: string) => opts.childFiles ?? []),
  );

  const promptBuilderBuild = vi.fn(
    opts.promptBuilderBuild ?? ((_p: unknown) => 'BASE_PROMPT'),
  );
  const systemPromptBuilder = { build: promptBuilderBuild };

  const { host } =
    opts.host !== undefined
      ? { host: opts.host }
      : makeHost();

  const deps = {
    agentRunner,
    sessionManager,
    systemPromptBuilder,
    onEvent,
    host,
    loadContextFilesFromDir: loader,
  } as unknown as SubagentRunnerDeps;

  return {
    deps,
    events,
    agentRunnerRun: agentRunner.run,
    sessionManagerDelete,
    loader,
    promptBuilderBuild,
    host,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('SubagentRunner.run', () => {
  // (a) systemPromptBuilder called with mode='minimal' + merged context + workspace/safety
  describe('(a) system prompt is built via systemPromptBuilder.build({mode:"minimal", ...})', () => {
    it('passes mode=minimal, workspaceDir, safetyLevel, and parent contextFiles (no child dir)', async () => {
      const { host } = (() => {
        const h = makeHost({
          workspaceDir: '/work',
          promptSafetyLevel: 'strict',
        });
        return { host: h.host };
      })();
      const { deps, promptBuilderBuild } = makeDeps({ host });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      expect(promptBuilderBuild).toHaveBeenCalledTimes(1);
      const params = promptBuilderBuild.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.mode).toBe('minimal');
      expect(params.workspaceDir).toBe('/work');
      expect(params.safetyLevel).toBe('strict');
      expect(params.contextFiles).toEqual(PARENT_FILES);
      // tools / availableSubagents intentionally not passed
      expect(params.tools).toBeUndefined();
      expect(params.availableSubagents).toBeUndefined();
    });
  });

  // (b) addendum appended after a blank line
  it('(b) appends the behavioral addendum at the end with a blank-line separator', async () => {
    const { deps, agentRunnerRun } = makeDeps({
      promptBuilderBuild: () => 'BASE_PROMPT_BODY',
    });
    const runner = new SubagentRunner(deps);
    await runner.run(makeRequest({ description: 'task-X' }));

    const runParams = (agentRunnerRun.mock.calls[0]![0] as RunParams);
    expect(runParams.systemPrompt.startsWith('BASE_PROMPT_BODY\n\n')).toBe(true);
    expect(runParams.systemPrompt).toContain('# Subagent Instructions');
    expect(runParams.systemPrompt).toContain('Task: task-X');
  });

  it('(b-edge) does NOT prepend "\\n\\n" when base prompt is empty', async () => {
    const { deps, agentRunnerRun } = makeDeps({ promptBuilderBuild: () => '' });
    const runner = new SubagentRunner(deps);
    await runner.run(makeRequest());

    const runParams = agentRunnerRun.mock.calls[0]![0] as RunParams;
    expect(runParams.systemPrompt.startsWith('# Subagent Instructions')).toBe(true);
  });

  // (c) child files complete → merged contextFiles are just the child files
  it('(c) when child dir has every file, merged contextFiles equal child files (parent ignored value-wise)', async () => {
    const childFiles: ContextFile[] = [
      { path: 'IDENTITY.md', content: 'child-identity' },
      { path: 'SOUL.md', content: 'child-soul' },
      { path: 'AGENTS.md', content: 'child-agents' },
      { path: 'TOOLS.md', content: 'child-tools' },
    ];

    // Real tempdir so existsSync(profile.agentDir) returns true.
    const ws = await mkdtemp(join(tmpdir(), 'subagent-runner-test-'));
    try {
      const agentDir = join(ws, '.agent', 'subagents', 'reviewer');
      await mkdir(agentDir, { recursive: true });
      // (We don't actually need the files on disk because the loader is mocked.)

      const { deps, promptBuilderBuild } = makeDeps({ childFiles });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest({ profile: makeProfile({ agentDir }) }));

      const params = promptBuilderBuild.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.contextFiles).toEqual(childFiles);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // (d) partial child files → per-file merge
  it('(d) per-file merge: child fills present names, parent fills missing names', async () => {
    const childFiles: ContextFile[] = [
      { path: 'IDENTITY.md', content: 'child-identity' },
      { path: 'AGENTS.md', content: 'child-agents' },
    ];

    const ws = await mkdtemp(join(tmpdir(), 'subagent-runner-test-'));
    try {
      const agentDir = join(ws, '.agent', 'subagents', 'reviewer');
      await mkdir(agentDir, { recursive: true });

      const { deps, promptBuilderBuild } = makeDeps({ childFiles });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest({ profile: makeProfile({ agentDir }) }));

      const params = promptBuilderBuild.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.contextFiles).toEqual([
        { path: 'IDENTITY.md', content: 'child-identity' },
        { path: 'SOUL.md', content: 'parent-soul' },
        { path: 'AGENTS.md', content: 'child-agents' },
        { path: 'TOOLS.md', content: 'parent-tools' },
      ]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // (e) child dir missing → fall back fully to parent
  it('(e) when child dir does not exist, loader is NOT called and merged = parent files', async () => {
    const { deps, promptBuilderBuild, loader } = makeDeps();
    const runner = new SubagentRunner(deps);
    await runner.run(makeRequest({ profile: makeProfile({ agentDir: '/no/such/path' }) }));

    expect(loader).not.toHaveBeenCalled();
    const params = promptBuilderBuild.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.contextFiles).toEqual(PARENT_FILES);
  });

  // (f) addendum content reflects depth + canSpawn
  describe('(f) behavioral addendum content', () => {
    it('contains task description and child depth, omits "cannot spawn" when canSpawn=true (maxDepth=2)', async () => {
      const { host } = makeHost({ maxDepth: 2 });
      const { deps, agentRunnerRun } = makeDeps({ host });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest({ description: 'task-Y' }));

      const runParams = agentRunnerRun.mock.calls[0]![0] as RunParams;
      expect(runParams.systemPrompt).toContain('Task: task-Y');
      expect(runParams.systemPrompt).toContain('Depth: 1');
      expect(runParams.systemPrompt).not.toContain('cannot spawn');
    });

    it('includes "cannot spawn" when canSpawn=false (maxDepth=1)', async () => {
      const { host } = makeHost({ maxDepth: 1 });
      const { deps, agentRunnerRun } = makeDeps({ host });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      const runParams = agentRunnerRun.mock.calls[0]![0] as RunParams;
      expect(runParams.systemPrompt).toContain('cannot spawn subagents');
    });
  });

  // (g) host.registerTurnContext / releaseTurnContext lifecycle
  describe('(g) host turn-context lifecycle', () => {
    it('register is called BEFORE agentRunner.run; release is called AFTER (happy path)', async () => {
      const callOrder: string[] = [];
      const { host } = makeHost();
      const register = host.registerTurnContext as ReturnType<typeof vi.fn>;
      const release = host.releaseTurnContext as ReturnType<typeof vi.fn>;
      register.mockImplementation(() => {
        callOrder.push('register');
      });
      release.mockImplementation(() => {
        callOrder.push('release');
      });
      const { deps } = makeDeps({
        host,
        agentRunnerRun: async () => {
          callOrder.push('agentRunner.run');
          return {
            text: 'ok',
            content: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
            toolRounds: 0,
          };
        },
      });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      expect(callOrder).toEqual(['register', 'agentRunner.run', 'release']);
    });

    it('release is still called when agentRunner.run throws (finally path)', async () => {
      const { host } = makeHost();
      const release = host.releaseTurnContext as ReturnType<typeof vi.fn>;
      const { deps } = makeDeps({
        host,
        agentRunnerRun: async () => {
          throw new Error('boom');
        },
      });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('register / release are called with the same childTurnId', async () => {
      const { host } = makeHost();
      const register = host.registerTurnContext as ReturnType<typeof vi.fn>;
      const release = host.releaseTurnContext as ReturnType<typeof vi.fn>;
      const { deps } = makeDeps({ host });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      const registeredTurnId = register.mock.calls[0]![0];
      const releasedTurnId = release.mock.calls[0]![0];
      expect(releasedTurnId).toBe(registeredTurnId);
    });
  });

  // (h) model resolution
  describe('(h) model resolution', () => {
    it('uses host.llmDefaults.model when profile.model is undefined', async () => {
      const { deps, agentRunnerRun } = makeDeps();
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest({ profile: makeProfile({ model: undefined }) }));
      expect((agentRunnerRun.mock.calls[0]![0] as RunParams).model).toBe('host-default-model');
    });

    it('uses host.llmDefaults.model when profile.model === "inherit"', async () => {
      const { deps, agentRunnerRun } = makeDeps();
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest({ profile: makeProfile({ model: 'inherit' }) }));
      expect((agentRunnerRun.mock.calls[0]![0] as RunParams).model).toBe('host-default-model');
    });

    it('uses profile.model directly when it is a concrete id', async () => {
      const { deps, agentRunnerRun } = makeDeps();
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest({ profile: makeProfile({ model: 'gpt-5' }) }));
      expect((agentRunnerRun.mock.calls[0]![0] as RunParams).model).toBe('gpt-5');
    });
  });

  // ── Event emission ──────────────────────────────────────

  describe('event emission', () => {
    it('emits subagent_start BEFORE agentRunner.run, subagent_end AFTER (happy path)', async () => {
      const sequence: string[] = [];
      const events: AgentEvent[] = [];
      const onEvent = (e: AgentEvent) => {
        events.push(e);
        sequence.push(e.type);
      };
      const { deps } = makeDeps({
        onEvent,
        agentRunnerRun: async () => {
          sequence.push('agentRunner.run');
          return {
            text: 'x',
            content: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5 },
            toolRounds: 0,
          };
        },
      });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      expect(sequence).toEqual(['subagent_start', 'agentRunner.run', 'subagent_end']);
      const start = events[0] as Extract<AgentEvent, { type: 'subagent_start' }>;
      const end = events[1] as Extract<AgentEvent, { type: 'subagent_end' }>;
      expect(start.runId).toBe(end.runId);
      expect(start.sessionKey).toBe(end.sessionKey);
      expect(start.turnId).toBe(end.turnId);
      expect(end.outcome).toBe('ok');
      expect(end.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it('emits subagent_end with outcome=max_llm_calls when AgentRunner stops on the limit', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({
        onEvent: (e) => events.push(e),
        agentRunnerRun: async () => ({
          text: '',
          content: [],
          stopReason: 'max_llm_calls',
          usage: { inputTokens: 20, outputTokens: 10 },
          toolRounds: 2,
        }),
      });
      const runner = new SubagentRunner(deps);
      const result = await runner.run(makeRequest());

      const end = events.find((e) => e.type === 'subagent_end') as Extract<
        AgentEvent,
        { type: 'subagent_end' }
      >;
      expect(end.outcome).toBe('max_llm_calls');
      expect(result.outcome).toBe('max_llm_calls');
    });

    it('subagent_start.depth matches childSessionKey depth', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({ onEvent: (e) => events.push(e) });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      const start = events[0] as Extract<AgentEvent, { type: 'subagent_start' }>;
      expect(start.depth).toBe(getSubagentDepth(start.sessionKey));
      expect(start.depth).toBe(1);
    });

    it('depth = parentDepth + 1 (so a depth-1 parent produces a depth-2 child)', async () => {
      const events: AgentEvent[] = [];
      const { host } = makeHost({ maxDepth: 3 });
      const { deps } = makeDeps({ host, onEvent: (e) => events.push(e) });
      const runner = new SubagentRunner(deps);
      await runner.run(
        makeRequest({ parentSessionKey: 'main:subagent:abc:1' }),
      );

      const start = events[0] as Extract<AgentEvent, { type: 'subagent_start' }>;
      expect(start.depth).toBe(2);
    });

    it('subagent_start carries lifecycle="blocking" and the original trigger', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({ onEvent: (e) => events.push(e) });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      const start = events[0] as Extract<AgentEvent, { type: 'subagent_start' }>;
      expect(start.lifecycle).toBe('blocking');
      expect(start.trigger).toEqual(TRIGGER);
    });
  });

  // ── Error path ──────────────────────────────────────────

  describe('error path', () => {
    it('returns SubagentRunResult{outcome:"error"} when agentRunner.run throws — does NOT rethrow', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({
        onEvent: (e) => events.push(e),
        agentRunnerRun: async () => {
          throw new Error('LLM exploded');
        },
      });
      const runner = new SubagentRunner(deps);
      const result = await runner.run(makeRequest());

      expect(result.outcome).toBe('error');
      expect(result.reason).toBe('LLM exploded');
      expect(result.text).toBe('');
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('emits subagent_end{outcome:"error", usage={0,0}, reason} on the error path', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({
        onEvent: (e) => events.push(e),
        agentRunnerRun: async () => {
          throw new Error('boom');
        },
      });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());

      const end = events.find((e) => e.type === 'subagent_end') as Extract<
        AgentEvent,
        { type: 'subagent_end' }
      >;
      expect(end.outcome).toBe('error');
      expect(end.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(end.reason).toBe('boom');
    });

    it('still calls release + deleteSession on the error path (finally)', async () => {
      const { host } = makeHost();
      const release = host.releaseTurnContext as ReturnType<typeof vi.fn>;
      const { deps, sessionManagerDelete } = makeDeps({
        host,
        agentRunnerRun: async () => {
          throw new Error('boom');
        },
      });
      const runner = new SubagentRunner(deps);
      await runner.run(makeRequest());
      expect(release).toHaveBeenCalledTimes(1);
      expect(sessionManagerDelete).toHaveBeenCalledTimes(1);
    });
  });

  // ── Cleanup ─────────────────────────────────────────────

  describe('cleanup', () => {
    it('calls deleteSession with the child sessionKey on the happy path', async () => {
      const { deps, sessionManagerDelete } = makeDeps();
      const runner = new SubagentRunner(deps);
      const result = await runner.run(makeRequest());
      expect(sessionManagerDelete).toHaveBeenCalledTimes(1);
      expect(sessionManagerDelete.mock.calls[0]![0]).toBe(result.sessionKey);
    });

    it('does NOT throw when deleteSession itself throws', async () => {
      const { deps } = makeDeps({
        sessionManagerDelete: async () => {
          throw new Error('disk full');
        },
      });
      const runner = new SubagentRunner(deps);
      const result = await runner.run(makeRequest());
      expect(result.outcome).toBe('ok');
    });
  });

  // ── Library trigger ───────────────────────────────────

  describe('library trigger', () => {
    it('uses callerLabel as rootLabel when provided', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({ onEvent: (e) => events.push(e) });
      const runner = new SubagentRunner(deps);
      await runner.run(
        makeRequest({
          trigger: { source: 'library', callerLabel: 'integration-test' },
          parentSessionKey: 'main',
        }),
      );

      const start = events[0] as Extract<AgentEvent, { type: 'subagent_start' }>;
      expect(start.sessionKey.startsWith('integration-test:subagent:')).toBe(true);
    });

    it('falls back to "library" as rootLabel when callerLabel is omitted', async () => {
      const events: AgentEvent[] = [];
      const { deps } = makeDeps({ onEvent: (e) => events.push(e) });
      const runner = new SubagentRunner(deps);
      await runner.run(
        makeRequest({
          trigger: { source: 'library' },
          parentSessionKey: 'main',
        }),
      );

      const start = events[0] as Extract<AgentEvent, { type: 'subagent_start' }>;
      expect(start.sessionKey.startsWith('library:subagent:')).toBe(true);
    });
  });
});
