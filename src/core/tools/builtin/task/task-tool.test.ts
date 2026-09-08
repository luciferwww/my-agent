import { describe, it, expect, vi } from 'vitest';
import { createTaskTool, type TaskToolDeps } from './task-tool.js';
import type { ToolExecutionContext, ToolExecutionOutput } from '../../types.js';
import type {
  SubagentCapabilities,
  SubagentDelegationRequest,
  SubagentProfile,
  SubagentTerminalResult,
} from '../../../subagent/types.js';

// ── Fixtures ────────────────────────────────────────────────

function profile(id: string, overrides: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id,
    description: `${id} subagent`,
    agentDir: `/ws/.agent/subagents/${id}`,
    model: 'inherit',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionKey: 'main',
    turnId: 'turn-1',
    callId: 'tu-42',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function caps(canSpawn: boolean, depth = 0): SubagentCapabilities {
  return { depth, role: canSpawn ? 'main' : 'leaf', canSpawn };
}

function okResult(overrides: Partial<SubagentTerminalResult> = {}): SubagentTerminalResult {
  return {
    runId: 'run-1',
    sessionKey: 'main:subagent:run-1:1',
    turnId: 'child-turn-1',
    text: 'subagent final answer',
    outcome: 'ok',
    usage: { inputTokens: 100, outputTokens: 50 },
    durationMs: 1234,
    ...overrides,
  };
}

interface BuildDepsOpts {
  registry?: Map<string, SubagentProfile>;
  capabilities?: SubagentCapabilities;
  maxDepth?: number;
  runResult?: SubagentTerminalResult | (() => Promise<SubagentTerminalResult>);
  runThrows?: unknown;
}

function makeDeps(opts: BuildDepsOpts = {}) {
  const registry =
    opts.registry ??
    new Map<string, SubagentProfile>([
      ['general-purpose', profile('general-purpose')],
      ['reviewer', profile('reviewer')],
    ]);
  const capabilities = opts.capabilities ?? caps(true);

  const delegate = vi.fn(
    async (_req: SubagentDelegationRequest): Promise<SubagentTerminalResult> => {
      if (opts.runThrows !== undefined) {
        throw opts.runThrows;
      }
      if (typeof opts.runResult === 'function') {
        return await opts.runResult();
      }
      return opts.runResult ?? okResult();
    },
  );
  const getCapabilities = vi.fn((_sessionKey: string) => capabilities);

  const deps: TaskToolDeps = {
    delegationPort: { delegate },
    profileRegistry: registry,
    getCapabilities,
    maxDepth: opts.maxDepth ?? 2,
  };

  return { deps, delegate, getCapabilities, registry };
}

// Strongly typed exec helper.
async function exec(
  tool: ReturnType<typeof createTaskTool>,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutput> {
  return await tool.execute(input, ctx);
}

// ── Tool shape ──────────────────────────────────────────────

describe('createTaskTool — Tool shape', () => {
  it('returns a tool named "task" with an object inputSchema', () => {
    const { deps } = makeDeps();
    const tool = createTaskTool(deps);
    expect(tool.name).toBe('task');
    expect(typeof tool.description).toBe('string');
    expect((tool.inputSchema as { type?: string }).type).toBe('object');
    const required = (tool.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain('description');
    expect(required).toContain('prompt');
  });
});

// ── (a) ctx.callId is forwarded as parentToolUseId ─────

describe('(a) Parent correlation forwarding', () => {
  it('passes ctx.sessionKey / turnId / callId into the delegation request', async () => {
    const { deps, delegate } = makeDeps();
    const tool = createTaskTool(deps);

    await exec(
      tool,
      { description: 'x', prompt: 'y' },
      makeCtx({ sessionKey: 'main', turnId: 'turn-7', callId: 'tu-999' }),
    );

    expect(delegate).toHaveBeenCalledTimes(1);
    const req = delegate.mock.calls[0]![0];
    expect(req.parent).toEqual({
      sessionKey: 'main',
      turnId: 'turn-7',
      toolUseId: 'tu-999',
    });
  });

  it('forwards description and prompt verbatim', async () => {
    const { deps, delegate } = makeDeps();
    const tool = createTaskTool(deps);
    await exec(
      tool,
      { description: 'audit it', prompt: 'audit the PR' },
      makeCtx(),
    );
    const req = delegate.mock.calls[0]![0];
    expect(req.description).toBe('audit it');
    expect(req.prompt).toBe('audit the PR');
  });
});

// ── (b) unknown subagent_type → general-purpose fallback ──

describe('(b) unknown subagent_type fallback', () => {
  it('falls back to general-purpose when subagent_type is not registered', async () => {
    const { deps, delegate } = makeDeps();
    const tool = createTaskTool(deps);
    await exec(
      tool,
      { description: 'x', prompt: 'y', subagent_type: 'nonexistent' },
      makeCtx(),
    );
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate.mock.calls[0]![0].profile.id).toBe('general-purpose');
  });

  it('uses general-purpose when subagent_type is omitted entirely', async () => {
    const { deps, delegate } = makeDeps();
    const tool = createTaskTool(deps);
    await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(delegate.mock.calls[0]![0].profile.id).toBe('general-purpose');
  });

  it('uses the named profile when subagent_type matches a registered id', async () => {
    const { deps, delegate } = makeDeps();
    const tool = createTaskTool(deps);
    await exec(
      tool,
      { description: 'x', prompt: 'y', subagent_type: 'reviewer' },
      makeCtx(),
    );
    expect(delegate.mock.calls[0]![0].profile.id).toBe('reviewer');
  });

  it('returns failed when even general-purpose is missing (programming-error guard)', async () => {
    const registry = new Map<string, SubagentProfile>([['reviewer', profile('reviewer')]]);
    const { deps, delegate } = makeDeps({ registry });
    const tool = createTaskTool(deps);
    const res = await exec(
      tool,
      { description: 'x', prompt: 'y', subagent_type: 'nonexistent' },
      makeCtx(),
    );
    expect(res.outcome).toBe('failed');
    expect(res.content).toMatch(/general-purpose/i);
    expect(delegate).not.toHaveBeenCalled();
  });
});

// ── (c) depth check ───────────────────────────────────────

describe('(c) depth check', () => {
  it('returns failed and does NOT delegate when canSpawn=false', async () => {
    const { deps, delegate } = makeDeps({
      capabilities: caps(false, 2),
      maxDepth: 2,
    });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.outcome).toBe('failed');
    expect(res.content).toMatch(/depth limit/i);
    expect(res.content).toMatch(/maxDepth=2/);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('delegates when canSpawn=true', async () => {
    const { deps, delegate } = makeDeps({ capabilities: caps(true, 0) });
    const tool = createTaskTool(deps);
    await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('queries capabilities with ctx.sessionKey', async () => {
    const { deps, getCapabilities } = makeDeps();
    const tool = createTaskTool(deps);
    await exec(tool, { description: 'x', prompt: 'y' }, makeCtx({ sessionKey: 'main:subagent:r:1' }));
    expect(getCapabilities).toHaveBeenCalledWith('main:subagent:r:1');
  });
});

// ── (d) outcome → ToolExecutionOutput matrix ──────────────

describe('(d) outcome → ToolExecutionOutput mapping (spec §13.2 failure matrix)', () => {
  it('outcome=ok → canonical success with the subagent text', async () => {
    const { deps } = makeDeps({ runResult: okResult({ text: 'hello' }) });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.content).toBe('hello');
    expect(res.outcome).toBe('success');
  });

  it('outcome=max_llm_calls → failed + content contains partial text', async () => {
    const { deps } = makeDeps({
      runResult: okResult({ outcome: 'max_llm_calls', text: 'halfway through...' }),
    });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.outcome).toBe('failed');
    expect(res.content).toMatch(/LLM call limit/);
    expect(res.content).toContain('halfway through...');
  });

  it('outcome=error → failed + content contains reason', async () => {
    const { deps } = makeDeps({
      runResult: okResult({
        outcome: 'error',
        text: '',
        failure: { phase: 'execution', message: 'LLM exploded' },
      }),
    });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.outcome).toBe('failed');
    expect(res.content).toContain('LLM exploded');
  });

  it('outcome=error without reason → "unknown error"', async () => {
    const { deps } = makeDeps({ runResult: okResult({ outcome: 'error', text: '' }) });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.outcome).toBe('failed');
    expect(res.content).toContain('unknown error');
  });

  it('outcome=aborted → failed + "aborted" message (v1 unreachable; branch coverage)', async () => {
    const { deps } = makeDeps({ runResult: okResult({ outcome: 'aborted', text: '' }) });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.outcome).toBe('failed');
    expect(res.content).toMatch(/aborted/i);
  });
});

// ── ContextOverflowError path ─────────────────────────────

describe('delegation rejection handling', () => {
  it('translates a delegation rejection into a user-facing failure', async () => {
    const { deps } = makeDeps({
      runThrows: new Error('Subagent requires an active matching Parent Turn.'),
    });
    const tool = createTaskTool(deps);
    const res = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(res.outcome).toBe('failed');
    expect(res.content).toMatch(/active matching Parent Turn/i);
  });

  it('normalizes unexpected delegation errors', async () => {
    const { deps } = makeDeps({ runThrows: new Error('unexpected') });
    const tool = createTaskTool(deps);
    const result = await exec(tool, { description: 'x', prompt: 'y' }, makeCtx());
    expect(result).toEqual({ outcome: 'failed', content: 'unexpected' });
  });
});
