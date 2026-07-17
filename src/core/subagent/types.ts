import type { TokenUsage } from '../../adapters/llm/types.js';
import type { ContextFile } from '../workspace/types.js';
import type { AgentRunner } from '../runner/index.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { AgentEvent } from '../runner/types.js';
import type { SystemPromptBuilder } from '../prompt/SystemPromptBuilder.js';

// ── Profile / role / capabilities ────────────────────────────

/**
 * Static configuration for a named subagent profile.
 *
 * `agentDir` is the **absolute path** to the role-personality directory
 * (`<workspaceDir>/.agent/subagents/<id>/`). The config-loader always
 * derives it from `id` + `workspaceDir`; users do not set it directly.
 * Whether the directory actually exists is probed at run time by the
 * SubagentRunner (deciding anonymous vs named context-files behavior).
 */
export interface SubagentProfile {
  id: string;
  description: string;
  agentDir: string;
  /** `'inherit'` (default) or a concrete LLM model id. */
  model?: string;
  tools?: {
    /** Replace semantics: when set, only listed tools are visible. */
    allow?: string[];
    /** Additive semantics: listed tools are removed on top of `allow`. */
    deny?: string[];
  };
  /** LLM-call budget for one subagent run. Inherits from parent when omitted. */
  maxLlmCalls?: number;
}

export type SubagentRole = 'main' | 'orchestrator' | 'leaf';

export interface SubagentCapabilities {
  depth: number;
  role: SubagentRole;
  canSpawn: boolean;
}

// ── Run trigger / lifecycle ──────────────────────────────────

export type RunTrigger =
  | {
      source: 'llm-tool';
      parentSessionKey: string;
      parentTurnId: string;
      parentToolUseId: string;
    }
  | {
      source: 'library';
      callerLabel?: string;
    };

/** v1 supports only blocking subagent runs. Background lifecycles are future work. */
export type RunLifecycle = 'blocking';

// ── External input / result types ────────────────────────────

/**
 * Shared input type for the LLM `task` tool **and** the library API
 * `RuntimeApp.runSubagentTurn(input)`. Each entry point resolves it to
 * a `SubagentRunRequest` (with `profile` looked up) before invoking
 * `SubagentRunner.run(...)`.
 */
export interface SubagentRunInput {
  /** Raw caller input: `'general-purpose'` or `SubagentProfile.id`. */
  subagentType: string;
  description: string;
  prompt: string;
  trigger: RunTrigger;
  lifecycle: RunLifecycle;
  /**
   * User abort / turn timeout / shutdown signal, forwarded down the chain to
   * `SubagentRunRequest.signal` → child `RunParams.signal`. See
   * core-abort-spec.md §6.4 / §8.4.
   */
  signal?: AbortSignal;
}

export interface SubagentRunResult {
  runId: string;
  sessionKey: string;
  turnId: string;
  text: string;
  /** `'aborted'` is reserved for the v2 abort subsystem; v1 never produces it. */
  outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
  reason?: string;
  /** Self + all transitive descendants (spec §6.1 decision 6). */
  usage: TokenUsage;
  durationMs: number;
}

// ── SubagentRunner contract (spec §8.5) ──────────────────────

/**
 * Runtime-provided bindings handed to a SubagentRunner at construction time.
 * The implementation lives in `runtime/subagent-orchestration.ts`;
 * `core/subagent/` only sees this interface.
 */
export interface SubagentHostBindings {
  registerTurnContext(childTurnId: string, parentTurnId: string): void;
  releaseTurnContext(childTurnId: string): void;
  /** Snapshot of the parent agent's loaded contextFiles, for fallback inheritance. */
  getParentContextFiles(): ContextFile[];
  readonly mainAgentTools: { allow: readonly string[]; deny: readonly string[] };
  readonly llmDefaults: { model: string; maxTokens: number; contextWindowTokens: number };
  readonly maxDepth: number;
  /** Workspace root, used by SystemPromptBuilder's `# Workspace` section. */
  readonly workspaceDir: string;
  /** Used by SystemPromptBuilder's `# Safety` section. */
  readonly promptSafetyLevel: 'relaxed' | 'normal' | 'strict';
}

/**
 * One-shot constructor deps for a SubagentRunner.
 *
 * `systemPromptBuilder` is reused from the main agent. SubagentRunner calls
 * `build({ mode: 'minimal', ... })` to get the datetime / safety /
 * project-context / workspace sections (see spec §11 minimal-mode table) and
 * then appends `behavioralAddendum` itself — it never hand-rolls
 * contextFiles concatenation.
 */
export interface SubagentRunnerDeps {
  agentRunner: AgentRunner;
  sessionManager: SessionManager;
  systemPromptBuilder: SystemPromptBuilder;
  onEvent: (event: AgentEvent) => void;
  host: SubagentHostBindings;
  loadContextFilesFromDir: (absDir: string) => Promise<ContextFile[]>;
  // A logger is created internally via `Logger.get('SubagentRunner')`.
}

/** Single-run input for `SubagentRunner.run(...)`. All fields are flattened. */
export interface SubagentRunRequest {
  profile: SubagentProfile;
  description: string;
  prompt: string;
  trigger: RunTrigger;
  lifecycle: RunLifecycle;
  /**
   * Forwarded from `SubagentRunInput.signal` (library API) or `ToolContext.signal`
   * (task tool). SubagentRunner passes it to the child `AgentRunner.run` as
   * `RunParams.signal`, so abort cascades naturally into the child turn.
   * See core-abort-spec.md §9.
   */
  signal?: AbortSignal;
  parentSessionKey: string;
  /** Replaces a raw `channel/clientId` pair: the parent turn id. */
  parentTurnId: string;
}
