import { Logger } from '../../../../platform/logger/index.js';
import { ContextOverflowError } from '../../../runner/errors.js';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import type { SubagentRunner } from '../../../subagent/SubagentRunner.js';
import type {
  SubagentProfile,
  SubagentCapabilities,
  SubagentRunResult,
} from '../../../subagent/types.js';

const log = Logger.get('task');

const GENERAL_PURPOSE_ID = 'general-purpose';

/**
 * Dependencies for {@link createTaskTool}.
 *
 * Deliberately small: every runtime concern that used to bloat this list
 * (model defaults, main-agent allow/deny, workspaceDir, ...) now lives in
 * `SubagentHostBindings` and is consumed by the SubagentRunner. The task
 * tool only needs to look up a profile, check depth, and delegate.
 */
export interface TaskToolDeps {
  subagentRunner: SubagentRunner;
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
 *     If `!canSpawn`, return a `ToolResult` with `isError: true` and do
 *     NOT invoke the SubagentRunner.
 *  3. Delegate to `subagentRunner.run(...)` with `parentSessionKey` /
 *     `parentTurnId` / `parentToolUseId` lifted from `ctx`.
 *  4. Map the returned `SubagentRunResult.outcome` to a `ToolResult` per
 *     spec §13.2 failure matrix.
 *  5. If a `ContextOverflowError` escapes the SubagentRunner (it shouldn't,
 *     but defensive), translate it to a user-facing error string. Other
 *     unexpected errors propagate to `createToolExecutor`'s isError wrap.
 */
export function createTaskTool(deps: TaskToolDeps): Tool {
  return {
    name: 'task',
    description:
      'Delegate an independent subtask to a subagent running in an isolated context. ' +
      'The subagent returns only its final text response. ' +
      'Pass all context the subagent needs in the prompt — it cannot see your conversation history.',
    inputSchema: INPUT_SCHEMA,

    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      // NOTE: v1 has no abort wiring — `ctx.signal` is always undefined here
      // (spec §6.1 decision 1). The abort subsystem will add an `aborted` early
      // return + cancellation cleanup here when it lands.

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
            content: 'No subagent profiles registered (missing general-purpose fallback).',
            isError: true,
          };
        }
      }

      // Depth check. Mirrors the addendum's `canSpawn` flag so the LLM
      // can't smuggle a `task` call through when it shouldn't be able to.
      const caps = deps.getCapabilities(ctx.sessionKey);
      if (!caps.canSpawn) {
        return {
          content: `Cannot spawn subagent: depth limit (maxDepth=${deps.maxDepth}) reached.`,
          isError: true,
        };
      }

      try {
        const result = await deps.subagentRunner.run({
          profile,
          description: params.description,
          prompt: params.prompt,
          trigger: {
            source: 'llm-tool',
            parentSessionKey: ctx.sessionKey,
            parentTurnId: ctx.turnId,
            parentToolUseId: ctx.toolUseId,
          },
          lifecycle: 'blocking',
          signal: ctx.signal,
          parentSessionKey: ctx.sessionKey,
          parentTurnId: ctx.turnId,
        });

        return formatSubagentResult(result);
      } catch (err) {
        if (err instanceof ContextOverflowError) {
          return {
            content:
              "Subagent context overflow: the task was too large for the subagent's context window " +
              'even after compaction. Consider breaking the task into smaller pieces, simplifying ' +
              'the prompt, or providing less background.',
            isError: true,
          };
        }
        // SubagentRunner's own catch maps errors to outcome='error' and
        // never rethrows, so we should not normally reach here. If we do,
        // let createToolExecutor's generic isError wrap handle it.
        throw err;
      }
    },
  };
}

/**
 * Map `SubagentRunResult.outcome` to a `ToolResult` per spec §13.2 failure matrix.
 *
 * - `'ok'`             → plain text, no isError
 * - `'max_llm_calls'`  → isError + partial-text hint
 * - `'aborted'`        → isError + "aborted" message. Unreachable in v1
 *                        (spec §6.1 decision 1); preserved for the future
 *                        abort subsystem.
 * - `'error'`          → isError + the failure reason
 */
function formatSubagentResult(result: SubagentRunResult): ToolResult {
  switch (result.outcome) {
    case 'ok':
      return { content: result.text };
    case 'max_llm_calls':
      return {
        content:
          'Subagent stopped after reaching the LLM call limit before completing. ' +
          `Partial output:\n${result.text}`,
        isError: true,
      };
    case 'aborted':
      return { content: 'Subagent was aborted before completing.', isError: true };
    case 'error':
      return {
        content: `Subagent failed: ${result.reason ?? 'unknown error'}`,
        isError: true,
      };
  }
}
