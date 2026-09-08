import { Logger } from '../../../../platform/logger/index.js';
import type { Tool, ToolExecutionContext, ToolExecutionOutput } from '../../types.js';
import type {
  SubagentDelegationPort,
  SubagentProfile,
  SubagentCapabilities,
  SubagentTerminalResult,
} from '../../../subagent/types.js';

const log = Logger.get('task');

const GENERAL_PURPOSE_ID = 'general-purpose';

/**
 * Dependencies for {@link createTaskTool}.
 *
 * Deliberately small: every runtime concern that used to bloat this list
 * (model selection, Parent validation, lifecycle, cleanup, ...) stays behind
 * the Runtime-owned delegation Port. The task tool only needs to look up a
 * profile, check depth, and delegate.
 */
export interface TaskToolDeps {
  delegationPort: SubagentDelegationPort;
  /** All registered profiles, keyed by id. Must include `'general-purpose'`. */
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
  /** Computes role/depth/canSpawn from a sessionKey (typically wraps `resolveSubagentCapabilities`). */
  getCapabilities: (sessionKey: string) => SubagentCapabilities;
  /** Used only for the user-facing error message when depth is exceeded. */
  maxDepth: number;
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'Short label for this subtask (shown in events).',
    },
    prompt: {
      type: 'string',
      description: 'The full instructions for the subagent. Include all context it needs.',
    },
    subagent_type: {
      type: 'string',
      description:
        'Subagent profile id. Omit or use "general-purpose" for the default assistant.',
    },
  },
  required: ['description', 'prompt'],
} as const;

interface TaskInput {
  description: string;
  prompt: string;
  subagent_type?: string;
}

/**
 * Build the `task` tool — the LLM-facing entry point for spawning a subagent.
 *
 * Flow per call (see spec §10.1 sequence diagram + §13.2 failure matrix):
 *  1. Resolve `subagent_type` → `SubagentProfile`. Unknown ids degrade to
 *     `'general-purpose'` with a warn log (spec §6 decision 10 LLM path).
 *  2. Belt-and-suspenders depth check via `getCapabilities(ctx.sessionKey)`.
  *     If `!canSpawn`, return a failed output and do
 *     NOT invoke the delegation Port.
 *  3. Require the active Parent tree signal from `ctx`.
 *  4. Delegate with Parent session/turn/tool-use correlation lifted from `ctx`.
 *  5. Map the returned terminal outcome to a canonical Tool output.
 */
export function createTaskTool(deps: TaskToolDeps): Tool {
  return {
    name: 'task',
    description:
      'Delegate an independent subtask to a subagent running in an isolated context. ' +
      'The subagent returns only its final text response. ' +
      'Pass all context the subagent needs in the prompt — it cannot see your conversation history.',
    inputSchema: INPUT_SCHEMA,

    async execute(
      input: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): Promise<ToolExecutionOutput> {
      // Abort cascade: `ctx.signal` (populated by the parent turn's
      // AbortController per core-abort-spec.md §8.1) flows through
      // delegation request signal → child RunParams.signal, so an abort on
      // the parent turn stops this subagent too. Its outcome then maps to
      // `'aborted'` in `formatSubagentResult` below.

      const params = input as unknown as TaskInput;
      const subagentType = params.subagent_type ?? GENERAL_PURPOSE_ID;

      // Profile lookup with fallback. The general-purpose profile is
      // always registered (RuntimeApp guarantees it in PR-6).
      let profile = deps.profileRegistry.get(subagentType);
      if (!profile) {
        log.warn('unknown subagent_type, falling back to general-purpose', {
          subagentType,
        });
        profile = deps.profileRegistry.get(GENERAL_PURPOSE_ID);
        if (!profile) {
          // Defensive: only reachable if bootstrap forgot to register the
          // default profile, which is a programming error.
          return {
            outcome: 'failed',
            content: 'No subagent profiles registered (missing general-purpose fallback).',
          };
        }
      }

      // Depth check. Mirrors the addendum's `canSpawn` flag so the LLM
      // can't smuggle a `task` call through when it shouldn't be able to.
      const caps = deps.getCapabilities(ctx.sessionKey);
      if (!caps.canSpawn) {
        return {
          outcome: 'failed',
          content: `Cannot spawn subagent: depth limit (maxDepth=${deps.maxDepth}) reached.`,
        };
      }

      try {
        const result = await deps.delegationPort.delegate({
          profile,
          description: params.description,
          prompt: params.prompt,
          parent: {
            sessionKey: ctx.sessionKey,
            turnId: ctx.turnId,
            toolUseId: ctx.callId,
          },
          signal: ctx.signal,
        });

        return formatSubagentResult(result);
      } catch (err) {
        return {
          outcome: 'failed',
          content: err instanceof Error ? err.message : 'Subagent delegation failed.',
        };
      }
    },
  };
}

/**
 * Map `SubagentTerminalResult.outcome` to a canonical Tool output.
 *
 * - `'ok'`             → success + plain text
 * - `'max_llm_calls'`  → failed + partial-text hint
 * - `'aborted'`        → failed + "aborted" message. Produced when the parent
 *                        turn's AbortController fires while the child is still
 *                        running (core-abort-spec.md §9). The LLM sees this
 *                        tool_result but the parent turn is unwinding, so the
 *                        message is mostly for the transcript log.
 * - `'error'`          → failed + the failure reason
 */
function formatSubagentResult(result: SubagentTerminalResult): ToolExecutionOutput {
  switch (result.outcome) {
    case 'ok':
      return { outcome: 'success', content: result.text };
    case 'max_llm_calls':
      return {
        outcome: 'failed',
        content:
          'Subagent stopped after reaching the LLM call limit before completing. ' +
          `Partial output:\n${result.text}`,
      };
    case 'aborted':
      return { outcome: 'failed', content: 'Subagent was aborted before completing.' };
    case 'error':
      return {
        outcome: 'failed',
        content: `Subagent failed: ${result.failure?.message ?? 'unknown error'}`,
      };
  }
}
