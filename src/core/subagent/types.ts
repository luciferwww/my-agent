import type { TokenUsage } from '../model-invocation/index.js';
import type { ModelReference, ResolutionFailureCategory } from '../model-resolution/index.js';

// ── Profile / role / capabilities ────────────────────────────

/**
 * Selected configuration for a Child Turn.
 *
 * `agentDir` is the **absolute path** to the role-personality directory
 * (`<agentHome>/agents/<id>/`). The config-loader always
 * derives it from `id` + `agentHome`; users do not set it directly.
 * Named Context is selected from the startup definition snapshot; the Child
 * executor never probes or rereads this directory during task preparation.
 */
export interface SubagentProfile {
  readonly id: string;
  readonly description: string;
  readonly agentDir: string;
  /** Explicit Parent-reference inheritance or a native Model Reference. */
  readonly model: 'inherit' | ModelReference;
  readonly tools?: {
    /** Approval bypass, not exclusive Tool availability. */
    readonly allow?: readonly string[];
    /** Denied Tools are unavailable; deny takes precedence. */
    readonly deny?: readonly string[];
  };
}

export interface SubagentProfileRegistry {
  readonly profiles: ReadonlyMap<string, SubagentProfile>;
  readonly disabledIds: ReadonlySet<string>;
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
  sessionId: string;
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
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolUseId: string;
  };
  /** Original active Parent Turn signal used only for delegation authority validation. */
  readonly parentSignal: AbortSignal;
  /** Execution-local cancellation signal used by the delegated Child. */
  readonly signal: AbortSignal;
  readonly reportActivity: () => void;
}

export interface SubagentDelegationPort {
  delegate(request: SubagentDelegationRequest): Promise<SubagentTerminalResult>;
}
