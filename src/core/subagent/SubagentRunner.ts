import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Logger } from '../../platform/logger/index.js';
import type { ContextFile } from '../workspace/types.js';
import type { RunParams } from '../runner/types.js';
import { formatSubagentSessionKey, getSubagentDepth } from './session-key.js';
import { resolveSubagentCapabilities } from './capabilities.js';
import { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';
import type {
  SubagentProfile,
  SubagentRunResult,
  SubagentRunRequest,
  SubagentRunnerDeps,
} from './types.js';

const log = Logger.get('SubagentRunner');

/**
 * Run a single subagent request to completion.
 *
 * Mirrors the public shape of {@link import('../runner/AgentRunner.js').AgentRunner}:
 * dependencies are injected once at construction; per-run state lives on
 * the `req` argument to {@link run}.
 *
 * Responsibilities (see spec §6.2 / §10 sequence diagrams):
 *  1. Derive the child sessionKey + childTurnId.
 *  2. Register the child turn with the runtime host (so events route back).
 *  3. Build the child system prompt: per-file merge with the parent's
 *     contextFiles, render via the shared SystemPromptBuilder in `'minimal'`
 *     mode, append the per-run behavioral addendum.
 *  4. Emit `subagent_start`, delegate to `AgentRunner.run`, emit `subagent_end`.
 *  5. In `finally`, release the host turn-context registration and best-effort
 *     delete the child session (spec §13 decision 11).
 *
 * Errors from `AgentRunner.run` are caught and returned as a
 * `SubagentRunResult` with `outcome: 'error'` (usage = `{0, 0}` per spec
 * §13.2 usage-source table). The error is never rethrown — the task tool
 * handles failure shaping per spec §13.2 failure matrix.
 */
export class SubagentRunner {
  constructor(private readonly deps: SubagentRunnerDeps) {}

  async run(req: SubagentRunRequest): Promise<SubagentRunResult> {
    const { profile, description, prompt, trigger, parentSessionKey, parentTurnId } = req;
    const startedAt = Date.now();
    const runId = randomUUID();
    const childTurnId = randomUUID();

    // 1) Derive child sessionKey (spec decision 3 — depth = parentDepth + 1)
    const parentDepth = getSubagentDepth(parentSessionKey);
    const childDepth = parentDepth + 1;
    const rootLabel =
      trigger.source === 'llm-tool'
        ? trigger.parentSessionKey
        : (trigger.callerLabel ?? 'library');
    const childSessionKey = formatSubagentSessionKey({
      rootLabel,
      runId,
      depth: childDepth,
    });

    // 2) Belt + suspenders capability check.
    // The task tool already verified `canSpawn` before reaching here; we
    // re-resolve only to feed `canSpawn` into the behavioral addendum.
    const capabilities = resolveSubagentCapabilities(
      childSessionKey,
      this.deps.host.maxDepth,
    );

    // 3) Register the child turn with the runtime host BEFORE emitting events
    // (host needs the routing to be in place for fanout to reach the right channel).
    this.deps.host.registerTurnContext(childTurnId, parentTurnId);

    // 4) Materialize the child session entry. AgentRunner.run requires the
    // session to exist in SessionManager's store (it calls getMessages /
    // sanitizeSessionTail during runAttempt). For the main agent this is
    // done by RuntimeApp.runTurn via resolveSession; the subagent path has
    // no equivalent wrapper, so the runner must create it here.
    await this.deps.sessionManager.resolveSession(childSessionKey, {
      spawnedBy: parentSessionKey,
    });

    // 4) Build the child system prompt.
    const childFiles = await this.loadChildContextFiles(profile);
    const parentFiles = this.deps.host.getParentContextFiles();
    const mergedFiles = mergeContextFilesByName(childFiles, parentFiles);
    const addendum = buildSubagentBehavioralAddendum({
      taskDescription: description,
      depth: childDepth,
      canSpawn: capabilities.canSpawn,
    });
    const basePrompt = this.deps.systemPromptBuilder.build({
      mode: 'minimal',
      contextFiles: mergedFiles,
      workspaceDir: this.deps.host.workspaceDir,
      safetyLevel: this.deps.host.promptSafetyLevel,
      // tools / availableSubagents intentionally omitted — minimal mode
      // skips both and v1 subagents don't carry a `task` tool anyway.
    });
    const systemPrompt = basePrompt
      ? `${basePrompt}\n\n${addendum}`
      : addendum;

    // 5) Slice 1 compatibility maps the current Child profile input into the
    // same authoritative Resolver used by Parent turns.
    const resolvedModel = this.deps.host.resolveLegacyChildModel({ model: profile.model });

    // 6) Assemble RunParams. `tools` is intentionally omitted in PR-3 — the
    // per-subagent tool bundle is computed by the runtime layer in PR-5 / PR-6
    // and threaded through the host. PR-3 tests pass a mocked AgentRunner.run
    // and assert on the fields populated here.
    //
    // `req.signal` cascades down to the child turn: the parent's AbortController
    // (owned by RuntimeApp per core-abort-spec.md §8.1) fires → the same signal
    // reaches child AgentRunner.run → child `stopReason='aborted'` → outcome
    // mapping below turns it into `'aborted'`. See core-abort-spec.md §9.
    const runParams: RunParams = {
      sessionKey: childSessionKey,
      message: prompt,
      resolvedModel,
      systemPrompt,
      turnId: childTurnId,
      maxLlmCalls: profile.maxLlmCalls, // undefined → AgentRunner default
      signal: req.signal,
    };

    // 7) Emit start, run, emit end / catch / finally.
    this.deps.onEvent({
      type: 'subagent_start',
      runId,
      sessionKey: childSessionKey,
      turnId: childTurnId,
      depth: childDepth,
      subagentType: profile.id,
      lifecycle: 'blocking',
      trigger,
    });

    let result: SubagentRunResult;
    try {
      const runResult = await this.deps.agentRunner.run(runParams);
      // `'aborted'` is checked FIRST so a signal that fires between AgentRunner's
      // last LLM call and its return does not get miscategorized as `'ok'` /
      // `'max_llm_calls'`. AgentRunner produces `stopReason='aborted'` via its
      // `buildAbortedResult` path (core-abort-spec.md §7.2). The `'error'`
      // outcome still belongs exclusively to the catch branch below.
      const outcome: SubagentRunResult['outcome'] =
        runResult.stopReason === 'aborted'
          ? 'aborted'
          : runResult.stopReason === 'max_llm_calls'
            ? 'max_llm_calls'
            : 'ok';
      result = {
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        text: runResult.text,
        outcome,
        usage: runResult.usage,
        durationMs: Date.now() - startedAt,
      };
      this.deps.onEvent({
        type: 'subagent_end',
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        depth: childDepth,
        subagentType: profile.id,
        lifecycle: 'blocking',
        trigger,
        outcome,
        usage: runResult.usage,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result = {
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        text: '',
        outcome: 'error',
        reason,
        // Catch path forfeits usage tracking (spec §13.2 usage-source table).
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: Date.now() - startedAt,
      };
      this.deps.onEvent({
        type: 'subagent_end',
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        depth: childDepth,
        subagentType: profile.id,
        lifecycle: 'blocking',
        trigger,
        outcome: 'error',
        reason,
        usage: result.usage,
        durationMs: result.durationMs,
      });
      // Deliberately do NOT rethrow: SubagentRunResult{outcome:'error'} is the
      // public contract. The `task` tool maps it to a tool-result per spec §13.2.
    } finally {
      this.deps.host.releaseTurnContext(childTurnId);
      await this.cleanup(childSessionKey);
    }

    return result;
  }

  /**
   * Load context files from the subagent's `agentDir`. Returns `[]` when
   * the directory does not exist (anonymous subagent — spec §6 decision 10);
   * the caller merges this against the parent's contextFiles.
   */
  private async loadChildContextFiles(profile: SubagentProfile): Promise<ContextFile[]> {
    if (!existsSync(profile.agentDir)) return [];
    return await this.deps.loadContextFilesFromDir(profile.agentDir);
  }

  /**
   * Best-effort cleanup of the child session. A failure here is logged at
   * `warn` but never bubbles up — the subagent's result has already been
   * committed by the caller (spec §13 decision 11).
   */
  private async cleanup(sessionKey: string): Promise<void> {
    try {
      await this.deps.sessionManager.deleteSession(sessionKey);
    } catch (err) {
      log.warn('cleanup failed', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Per-file merge of child and parent `contextFiles` (spec §9.3).
 *
 * Iterates the parent's files in order; for each, prefers the child's
 * same-named entry if present, else falls back to the parent's.
 *
 * **No "extra child files" branch** because the loader only reads from a
 * fixed `ALL_FILES` whitelist (`IDENTITY.md` / `SOUL.md` / `AGENTS.md` /
 * `TOOLS.md`), so a subagent dir cannot contribute names the parent doesn't
 * already have. If `loader.ts` is ever generalized to read arbitrary `.md`,
 * this function must be extended.
 */
function mergeContextFilesByName(
  childFiles: ReadonlyArray<ContextFile>,
  parentFiles: ReadonlyArray<ContextFile>,
): ContextFile[] {
  const childByName = new Map<string, ContextFile>();
  for (const f of childFiles) childByName.set(f.path, f);
  return parentFiles.map((parent) => childByName.get(parent.path) ?? parent);
}
