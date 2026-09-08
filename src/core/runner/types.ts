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
 * 一次 run 期间事件标识所需的最小上下文。
 *
 * AgentRunner 内部沿调用链显式透传给所有 emit() 调用点，替代过往把
 * RunParams 整体挂在实例字段（this.currentParams）上的做法。这样：
 *  - emit 不再依赖隐式实例状态，类对事件标签无副作用、可重入、可并发；
 *  - 编译期强制每个 emit 调用提供 ctx；
 *  - Child executor 嵌套 AgentRunner.run() 不再有任何状态串号风险。
 *
 * 仅 sessionKey/turnId 两字段，故不复用 RunParams（后者太重，包含 message
 * / tools / model 等不适合作为事件 tag 到处传的内容）。
 */
export interface TurnContext {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly requestId: string;
}

/** AgentRunner 构造参数 */
export interface AgentRunnerConfig {
  /** Session 管理器 */
  sessionManager: import('../session/SessionManager.js').SessionManager;
  /** 运行时事件回调 */
  onEvent?: (event: AgentEvent) => void;
}

/** 单次 run 的参数 */
export interface RunParams {
  /** Session key */
  sessionKey: string;
  /** 用户消息文本或多模态 content blocks */
  message: string | ChatContentBlock[];
  /** 当前 Turn 已解析并固定的模型、调用端口、Facts 与执行限制 */
  resolvedModel: ResolvedModel;
  /** System prompt（由调用方通过 prompt-builder 构建） */
  systemPrompt: string;
  /** 本次 turn 的唯一 id；由 RuntimeApp 生成并传入 */
  turnId: string;
  /** Root request identity shared by every node in the execution tree. */
  requestId?: string;
  /** 当前 Turn 固定的 Tool/Hook projections 与 Application policy。 */
  toolProjection: ToolProjection;
  hookProjection: HookProjection;
  toolPolicy: ApplicationToolPolicy;
  /** 当前调用来源可提供的审批能力；缺失时 requires-approval fail closed。 */
  approvalCapability?: CurrentCallApprovalCapability;
  /** 单次 run 允许的最大 LLM 调用次数，默认 12 */
  maxLlmCalls?: number;
  /** steering 专用消息读取回调（总在 steering 注入点消费） */
  getSteeringMessages?: PendingMessageReader;
  /** 压缩配置（由 RuntimeApp 传入） */
  compaction?: CompactionConfig;
  /**
   * 触发本 turn 的 `user_message.messageId`。由 RuntimeApp 从 queued 路径透传；
   * 传入即在 run_start 上回写为 originMessageId，供客户端反向关联。
   * 见 channel-multi-client-user-message-spec §5.1 D6。
   */
  originMessageId?: string;
  /**
   * 用户中断 / turn timeout / shutdown 等都通过此 signal 传递。
  * AgentRunner 在 chatStream 调用 + ToolExecutionContext 构造时透传；
   * catch AbortError 后返回 RunResult.stopReason='aborted'，不抛。
   * 见 core-abort-spec.md §6.1。
   */
  signal?: AbortSignal;
}

/** 单次 run 的结果 */
export interface RunResult {
  /** 助手最终回复的文本 */
  text: string;
  /** 助手回复的完整 content blocks */
  content: ChatContentBlock[];
  /** stop reason */
  stopReason: string;
  /** 累计 token 用量（所有 LLM 调用的总和） */
  usage: TokenUsage;
  /** tool use 循环总轮数（所有外层迭代的总和） */
  toolRounds: number;
  /** 本次运行是否触发了压缩（Phase 2 实现后才会为 true） */
  compacted?: boolean;
}

/**
 * 用户消息附件摘要。仅广播用；原始字节仍走 transcript / LLM 路径。
 * 见 channel-multi-client-user-message-spec §5.1 D8。
 */
export interface AttachmentSummary {
  /** UI 至少要知道渲染哪种占位；未来加类型是 additive */
  type: 'image' | 'other';
  /** 文件名（若可得） */
  name?: string;
  /** 原始字节数（若可得） */
  bytes?: number;
  /** MIME type（若可得） */
  mime?: string;
}

/** 运行时事件 */
export type AgentEvent =
  | {
      type: 'run_start';
      sessionKey: string;
      turnId: string;
      requestId: string;
      /**
       * 反向关联到触发本 turn 的 `user_message.messageId`。
       * 仅 queued 路径有值；直接调用 runTurn / steering 无此字段。
       * 见 channel-multi-client-user-message-spec §5.1 D6。
       */
      originMessageId?: string;
    }
  /**
   * 用户输入广播。emit 时机在 assemble 通过后、queued/steering 分歧前，
   * 用于同 session 多 client 之间的可见性对齐。见 channel-multi-client-user-message-spec §5.3。
   *
   * 与 turnId 解耦：steering 消息不产生 turn，messageId 是独立生命周期。
   */
  | {
      type: 'user_message';
      sessionKey: string;
      /** emit 时生成的 UUID；后续 run_start 通过 originMessageId 反向关联 */
      messageId: string;
      /** 用户输入的文本部分（从 assembled 抽出并拼接） */
      content: string;
      /** 附件摘要；无附件时省略 */
      attachmentSummaries?: AttachmentSummary[];
      /** WS clientId；来自非 WS channel（CLI / library API）则为 null */
      originClientId: string | null;
      /** queued = 走 session 队列；steering = 注入运行中 turn */
      deliveryMode: 'queued' | 'steering';
      /** ms since epoch */
      timestamp: number;
    }
  | { type: 'text_delta'; sessionKey: string; turnId: string; text: string }
  | {
      type: 'tool_use';
      sessionKey: string;
      turnId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      sessionKey: string;
      turnId: string;
      name: string;
      result: ToolResult;
    }
  | { type: 'llm_call'; sessionKey: string; turnId: string; round: number }
    | { type: 'run_end'; sessionKey: string; turnId: string; requestId: string; result: RunResult }
  | {
      type: 'error';
      sessionKey: string;
      turnId: string;
      requestId: string;
      error: Error;
      category?: import('../model-resolution/index.js').ResolutionFailureCategory;
      originMessageId?: string;
    }
  | {
      type: 'request_end';
      requestId: string;
      sessionKey?: never;
      turnId?: never;
      originMessageId?: string;
      outcome: 'cancelled';
      reason: 'abort_queue_drop' | 'shutdown';
    }
  /** tool result 被 per-result 裁剪（Layer 1）时触发 */
  | {
      type: 'tool_result_pruned';
      sessionKey: string;
      turnId: string;
      toolUseId: string;
      originalChars: number;
      prunedChars: number;
    }
  /** 压缩开始：LLM 摘要生成前触发，包含触发原因和压缩前 token 数 */
  | {
      type: 'compaction_start';
      sessionKey: string;
      turnId: string;
      trigger: 'preemptive' | 'overflow' | 'manual';
      estimatedTokens: number;
    }
  /** 压缩结束：摘要写入 session 后触发，包含压缩效果统计 */
  | {
      type: 'compaction_end';
      sessionKey: string;
      turnId: string;
      tokensBefore: number;
      tokensAfter: number;
      droppedMessages: number;
    }
  /**
   * 会话末尾被净化：runAttempt / compactHistory 开头检测到当前分支末尾
   * 是孤立的 trailing user message，已通过 branch(parentId) 回退 leafId。
   * 仅修改内存，不写 JSONL；被丢弃的 entry 仍保留在文件中可审计。
   */
  | {
      type: 'session_tail_sanitized';
      sessionKey: string;
      turnId: string;
      discardedEntryId: string;
      discardedRole: 'user';
    }
  /**
   * 孤儿 tool_use 修复：runAttempt 入口检测到 session 末尾 assistant/user pair
   * 里存在缺失 tool_result 的 tool_use，已写 synthetic tool_result 补齐。
   *  - source='abort'：来自本项目 abort 路径（末尾 assistant 携 abortMeta.partial=true）
   *  - source='recovered'：其他来源（进程崩溃 / kill / bug 等，无 abortMeta）
   * 详见 core-abort-spec.md §7.3。
   */
  | {
      type: 'orphan_tool_results_repaired';
      sessionKey: string;
      turnId: string;
      /** 本次补写的 synthetic tool_result 块数（= 孤儿 tool_use id 数） */
      count: number;
      source: 'abort' | 'recovered';
    }
  | {
      type: 'subagent_start';
      requestId: string;
      /** 单次 subagent 运行的 runId（由 orchestrator 生成） */
      runId: string;
      /** 子 agent 的 sessionKey（含 :subagent: 后缀） */
      sessionKey: string;
      /** 子 agent 第一个 turn 的 id（与子的 run_start.turnId 相同） */
      turnId: string;
      /** 嵌套深度，与 `getSubagentDepth(sessionKey)` 一致 */
      depth: number;
      /** 'general-purpose' 或具名 profile.id（caller 原始输入） */
      subagentType: string;
      lifecycle: 'blocking';
      parentSessionKey: string;
      parentTurnId: string;
      parentToolUseId: string;
    }
  | {
      type: 'subagent_end';
      requestId: string;
      runId: string;
      sessionKey: string;
      turnId: string;
      depth: number;
      subagentType: string;
      lifecycle: 'blocking';
      parentSessionKey: string;
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
      /** 子自身 + 所有子孙累计（spec §6.1 决策 6） */
      usage: TokenUsage;
      durationMs: number;
    };
