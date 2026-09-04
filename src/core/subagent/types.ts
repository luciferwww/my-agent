import type { TokenUsage } from '../model-invocation/index.js';
import type { ContextFile } from '../workspace/types.js';
import type { ModelReference, ResolutionFailureCategory } from '../model-resolution/index.js';

// ── Profile / role / capabilities ────────────────────────────

/**
 * Static configuration for a named subagent profile.
 *
 * `agentDir` is the **absolute path** to the role-personality directory
 * (`<workspaceDir>/.agent/subagents/<id>/`). The config-loader always
 * derives it from `id` + `workspaceDir`; users do not set it directly.
 * Whether the directory actually exists is probed at run time by the
 * internal Child executor (deciding anonymous vs named context-files behavior).
 */
export interface SubagentProfile {
  id: string;
  description: string;
  agentDir: string;
  /** Explicit Parent-reference inheritance or a native Model Reference. */
  model: 'inherit' | ModelReference;
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

export type SubagentTerminalFailure =
  | { readonly phase: 'setup'; readonly message: string }
  | {
      readonly phase: 'resolution';
      readonly category: ResolutionFailureCategory;
      readonly message: string;
    }
  | { readonly phase: 'execution'; readonly message: string };

export interface SubagentTerminalResult {
  runId: string;
  sessionKey: string;
  turnId: string;
  text: string;
  /**
   * `'aborted'` fires when the caller-supplied `AbortSignal` trips before the
   * child turn reaches `end_turn` / `max_llm_calls`. Cascades from the parent's
   * `RuntimeApp.abortTurn(...)` via `RunParams.signal`.
   */
  outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
  failure?: SubagentTerminalFailure;
  /** Self + all transitive descendants (spec §6.1 decision 6). */
  usage: TokenUsage;
  durationMs: number;
}

export interface SubagentDelegationRequest {
  readonly profile: SubagentProfile;
  readonly description: string;
  readonly prompt: string;
  readonly parent: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly toolUseId: string;
  };
  readonly signal: AbortSignal;
}

export interface SubagentDelegationPort {
  delegate(request: SubagentDelegationRequest): Promise<SubagentTerminalResult>;
}
