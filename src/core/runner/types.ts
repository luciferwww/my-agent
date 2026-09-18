import type {
  ChatContentBlock,
  ChatMessage,
  TokenUsage,
} from '../model-invocation/index.js';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { CurrentCallApprovalCapability } from '../approval/index.js';
import type { HookProjection, ToolProjection } from '../registry/index.js';
import type { ApplicationToolPolicy, ToolResult } from '../tools/types.js';
import type { CompactionConfig } from '../../platform/config/types.js';

export type { ToolResult };

export type PendingMessageReader = () => ChatMessage[] | Promise<ChatMessage[]>;

/**
 * Minimal context required to identify events during one run.
 *
 * AgentRunner passes this explicitly to every emit() call instead of storing
 * RunParams on the instance. This keeps event tagging stateless, reentrant,
 * concurrency-safe, and required by the type checker.
 *
 * This deliberately contains only identities, rather than the much larger RunParams.
 */
export interface TurnContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestId: string;
}

/** AgentRunner constructor parameters. */
export interface AgentRunnerConfig {
  /** Session manager. */
  sessionManager: import('../session/SessionManager.js').SessionManager;
  /** Runtime event callback. */
  onEvent?: (event: AgentEvent) => void;
}

/** Parameters for one run. */
export interface RunParams {
  /** Session key */
  sessionId: string;
  /** Subagent nesting depth; root Turns default to zero. */
  subagentDepth?: number;
  /** User text or multimodal content blocks. */
  message: string | ChatContentBlock[];
  /** Model, invocation port, facts, and limits fixed for this Turn. */
  resolvedModel: ResolvedModel;
  /** System prompt built by the caller through prompt-builder. */
  systemPrompt: string;
  /** Unique Turn ID generated and passed by RuntimeApp. */
  turnId: string;
  /** Root request identity shared by every node in the execution tree. */
  requestId?: string;
  /** Tool and Hook projections plus Application policy fixed for this Turn. */
  toolProjection: ToolProjection;
  hookProjection: HookProjection;
  toolPolicy: ApplicationToolPolicy;
  /** Approval capability of this caller; requires-approval fails closed when absent. */
  approvalCapability?: CurrentCallApprovalCapability;
  /** Maximum LLM calls for one run; defaults to 12. */
  maxLlmCalls?: number;
  /** Reader consumed only at steering injection points. */
  getSteeringMessages?: PendingMessageReader;
  /** Compaction configuration supplied by RuntimeApp. */
  compaction?: CompactionConfig;
  /**
  * `user_message.messageId` that triggered this Turn. RuntimeApp passes it
  * from the queued path and run_start exposes it as originMessageId.
  * See channel-multi-client-user-message-spec section 5.1 D6.
   */
  originMessageId?: string;
  /**
  * Carries user aborts, Turn timeouts, shutdown, and similar cancellation.
  * AgentRunner forwards it to chatStream and ToolExecutionContext. An
  * AbortError returns RunResult.stopReason='aborted' instead of throwing.
  * See core-abort-spec.md section 6.1.
   */
  signal?: AbortSignal;
}

/** Result of one run. */
export interface RunResult {
  /** Final assistant response text. */
  text: string;
  /** Complete assistant response content blocks. */
  content: ChatContentBlock[];
  /** stop reason */
  stopReason: string;
  /** Cumulative token usage across all LLM calls. */
  usage: TokenUsage;
  /** Total tool-use rounds across all outer iterations. */
  toolRounds: number;
  /** Whether this run triggered compaction. */
  compacted?: boolean;
}

/**
 * Attachment summary for user-message broadcasts. Original bytes still use
 * the Transcript and LLM path. See channel-multi-client-user-message-spec section 5.1 D8.
 */
export interface AttachmentSummary {
  /** Minimum type required for the UI placeholder; future types are additive. */
  type: 'image' | 'other';
  /** File name, when available. */
  name?: string;
  /** Original byte count, when available. */
  bytes?: number;
  /** MIME type, when available. */
  mime?: string;
}

/** Runtime events. */
export type AgentEvent =
  | {
      type: 'run_start';
      sessionId: string;
      turnId: string;
      requestId: string;
      /**
      * Correlates this Turn to its triggering `user_message.messageId`.
      * Present only for the queued path, not direct runTurn or steering.
      * See channel-multi-client-user-message-spec section 5.1 D6.
       */
      originMessageId?: string;
    }
  /**
   * User-input broadcast emitted after assembly and before queued/steering
   * routing, keeping multiple clients for one Session consistent.
   *
   * Independent of turnId because steering messages do not create Turns.
   * See channel-multi-client-user-message-spec section 5.3.
   */
  | {
      type: 'user_message';
      sessionId: string;
      /** UUID generated when emitted; run_start correlates through originMessageId. */
      messageId: string;
      /** Text extracted and joined from the assembled user input. */
      content: string;
      /** Attachment summaries, omitted when there are no attachments. */
      attachmentSummaries?: AttachmentSummary[];
      /** WebSocket client ID, or null for CLI and library channels. */
      originClientId: string | null;
      /** queued uses the Session queue; steering injects into the active Turn. */
      deliveryMode: 'queued' | 'steering';
      /** ms since epoch */
      timestamp: number;
    }
  | { type: 'text_delta'; sessionId: string; turnId: string; text: string }
  | {
      type: 'tool_use';
      sessionId: string;
      turnId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      sessionId: string;
      turnId: string;
      name: string;
      result: ToolResult;
    }
  | { type: 'llm_call'; sessionId: string; turnId: string; round: number }
    | { type: 'run_end'; sessionId: string; turnId: string; requestId: string; result: RunResult }
  | {
      type: 'error';
      sessionId: string;
      turnId: string;
      requestId: string;
      error: Error;
      category?: import('../model-resolution/index.js').ResolutionFailureCategory;
      originMessageId?: string;
    }
  | {
      type: 'request_end';
      requestId: string;
      sessionId?: never;
      turnId?: never;
      originMessageId?: string;
      outcome: 'cancelled';
      reason: 'abort_queue_drop' | 'shutdown';
    }
  /** Emitted when a tool result is pruned individually at Layer 1. */
  | {
      type: 'tool_result_pruned';
      sessionId: string;
      turnId: string;
      toolUseId: string;
      originalChars: number;
      prunedChars: number;
    }
  /** Compaction start, before LLM summarization. */
  | {
      type: 'compaction_start';
      sessionId: string;
      turnId: string;
      trigger: 'preemptive' | 'overflow' | 'manual';
      estimatedTokens: number;
    }
  /** Compaction end, after the summary is persisted. */
  | {
      type: 'compaction_end';
      sessionId: string;
      turnId: string;
      tokensBefore: number;
      tokensAfter: number;
      droppedMessages: number;
    }
  /**
  * The Session tail was sanitized after runAttempt or compactHistory found an
  * orphan trailing user message. branch(parentId) moves the in-memory leaf;
  * the discarded entry remains in JSONL for audit.
   */
  | {
      type: 'session_tail_sanitized';
      sessionId: string;
      turnId: string;
      discardedEntryId: string;
      discardedRole: 'user';
    }
  /**
  * Orphan tool_use repair found missing tool_result blocks in the trailing
  * assistant/user pair and persisted synthetic results.
  * source='abort' identifies this project's abort path; source='recovered'
  * covers crashes, kills, bugs, and other causes. See core-abort-spec.md section 7.3.
   */
  | {
      type: 'orphan_tool_results_repaired';
      sessionId: string;
      turnId: string;
      /** Number of synthetic tool_result blocks persisted. */
      count: number;
      source: 'abort' | 'recovered';
    }
  | {
      type: 'subagent_start';
      requestId: string;
      /** Run ID generated by the orchestrator for one Subagent execution. */
      runId: string;
      /** Child Agent UUID. */
      sessionId: string;
      /** Child Agent's first Turn ID, matching its run_start.turnId. */
      turnId: string;
      /** Explicit Subagent nesting depth. */
      depth: number;
      /** 'general-purpose' or the named profile.id supplied by the caller. */
      subagentType: string;
      lifecycle: 'blocking';
      callerSessionId: string;
      parentTurnId: string;
      parentToolUseId: string;
    }
  | {
      type: 'subagent_end';
      requestId: string;
      runId: string;
      sessionId: string;
      turnId: string;
      depth: number;
      subagentType: string;
      lifecycle: 'blocking';
      callerSessionId: string;
      parentTurnId: string;
      parentToolUseId: string;
      /** Parent tree signal interrupted Child execution. */
      outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
      failure?:
        | { readonly phase: 'setup'; readonly message: string }
        | {
            readonly phase: 'resolution';
            readonly category: import('../model-resolution/index.js').ResolutionFailureCategory;
            readonly message: string;
          }
        | { readonly phase: 'execution'; readonly message: string };
      /** Cumulative usage for the Child and all descendants. */
      usage: TokenUsage;
      durationMs: number;
    };
