import type { AgentDefaults } from '../platform/config/types.js';
import type { ContextFile } from '../core/workspace/types.js';
import type { TokenUsage } from '../core/model-invocation/index.js';
import type { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import type {
  SubagentProfile,
  SubagentRunInput,
  SubagentRunResult,
  SubagentHostBindings,
} from '../core/subagent/types.js';
import type { MessageRouteContext } from './queue-types.js';

// ────────────────────────────────────────────────────────────────
// (A) SubagentHostBindings 实现工厂
// ────────────────────────────────────────────────────────────────

export interface CreateSubagentHostBindingsParams {
  /**
   * 父 contextFiles 的 getter。共享 RuntimeApp.resources 引用——
   * RuntimeApp 在 `reloadContextFiles()` 内部用 `this.resources.contextFiles = next`
   * 替换数组，host 通过 getter 自动看到最新值。
   */
  getParentContextFiles: () => ContextFile[];
  /**
   * RuntimeApp 的 routeContextByTurn map（共享引用）。
   * `registerTurnContext(child, parent)` 把父 ctx 复制到子 turnId，
   * 这样审批 hook 在子 turn 触发时能查到原始 channel 路由。
   */
  routeContextByTurn: Map<string, MessageRouteContext>;
  /**
   * resolvedConfig 快照——v1 启动后不变；hot-reload 时 RuntimeApp 须重建 host
   * 实例（§spec §8.5）。
   */
  resolvedConfig: AgentDefaults;
  resolveLegacyChildModel: SubagentHostBindings['resolveLegacyChildModel'];
  /** 工作区绝对路径，来源 RuntimeAppOptions.workspaceDir */
  workspaceDir: string;
}

/**
 * Build a `SubagentHostBindings` adapter over the runtime's mutable state.
 *
 * The returned object is pure adapter glue — every mutating method targets
 * the shared `routeContextByTurn` map, and `getParentContextFiles` is a
 * thin getter over the caller-provided closure so context reloads are
 * visible without rebuilding the bindings.
 */
export function createSubagentHostBindings(
  params: CreateSubagentHostBindingsParams,
): SubagentHostBindings {
  const tools = params.resolvedConfig.tools;
  const subagents = params.resolvedConfig.subagents;
  const prompt = params.resolvedConfig.prompt;

  return {
    registerTurnContext(childTurnId, parentTurnId) {
      const parentCtx = params.routeContextByTurn.get(parentTurnId);
      if (parentCtx) {
        params.routeContextByTurn.set(childTurnId, parentCtx);
      }
      // Parent ctx not found (library entry or routing not registered) → no-op.
      // Downstream approval hooks will fail-closed when no route exists.
    },
    releaseTurnContext(childTurnId) {
      params.routeContextByTurn.delete(childTurnId);
    },
    getParentContextFiles: params.getParentContextFiles,
    mainAgentTools: {
      allow: tools?.allow ?? [],
      deny: tools?.deny ?? [],
    },
    resolveLegacyChildModel: params.resolveLegacyChildModel,
    maxDepth: subagents?.maxDepth ?? 1,
    workspaceDir: params.workspaceDir,
    promptSafetyLevel: prompt?.safetyLevel ?? 'normal',
  };
}

// ────────────────────────────────────────────────────────────────
// (B) Library API: runSubagentTurn(input)
// ────────────────────────────────────────────────────────────────

export interface RunSubagentTurnDeps {
  subagentRunner: SubagentRunner;
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
}

/**
 * Library entry point for spawning a subagent.
 *
 * Differs from the LLM `task` tool in one important way: when
 * `input.subagentType` does not match a registered profile, this throws
 * a hard error instead of silently falling back to `general-purpose`
 * (spec §6 decision 10 — library callers should know exactly what they
 * are invoking; the LLM gets the leniency).
 *
 * For `trigger.source === 'library'`, synthesizes a `parentSessionKey`
 * and `parentTurnId` from `callerLabel` so the child gets a stable
 * `rootLabel` for its session-key derivation.
 */
export async function runSubagentTurn(
  input: SubagentRunInput,
  deps: RunSubagentTurnDeps,
): Promise<SubagentRunResult> {
  const profile = deps.profileRegistry.get(input.subagentType);
  if (!profile) {
    throw new Error(
      `Unknown subagent type: "${input.subagentType}". ` +
        'Library API requires a registered profile id (the LLM `task` tool can ' +
        'fall back to general-purpose, but the library API does not).',
    );
  }

  const parentSessionKey =
    input.trigger.source === 'library'
      ? (input.trigger.callerLabel ?? 'library')
      : input.trigger.parentSessionKey;
  const parentTurnId =
    input.trigger.source === 'library'
      ? `library-synthetic-${input.trigger.callerLabel ?? 'caller'}`
      : input.trigger.parentTurnId;

  return deps.subagentRunner.run({
    profile,
    description: input.description,
    prompt: input.prompt,
    trigger: input.trigger,
    lifecycle: input.lifecycle,
    signal: input.signal,
    parentSessionKey,
    parentTurnId,
  });
}

// ────────────────────────────────────────────────────────────────
// (C) usage 累加 helper
// ────────────────────────────────────────────────────────────────

/** Component-wise add two TokenUsage values. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
