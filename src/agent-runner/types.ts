import type { ChatContentBlock, TokenUsage } from '../llm-client/types.js';
import type { ToolDefinition, ToolResult, ToolExecutor } from '../tools/types.js';
import type { CompactionConfig } from '../config/types.js';

export type { ToolDefinition, ToolResult, ToolExecutor };

/** AgentRunner 构造参数 */
export interface AgentRunnerConfig {
  /** LLM 客户端 */
  llmClient: import('../llm-client/types.js').LLMClient;
  /** Session 管理器 */
  sessionManager: import('../session/SessionManager.js').SessionManager;
  /** 工具执行回调，不提供则 tool_use 时返回错误 */
  toolExecutor?: ToolExecutor;
  /** 运行时事件回调 */
  onEvent?: (event: AgentEvent) => void;
}

/** 单次 run 的参数 */
export interface RunParams {
  /** Session key */
  sessionKey: string;
  /** 用户消息文本 */
  message: string;
  /** 模型名称 */
  model: string;
  /** System prompt（由调用方通过 prompt-builder 构建） */
  systemPrompt: string;
  /** 本次 turn 的唯一 id；由 RuntimeApp 生成并传入 */
  turnId: string;
  /** 工具定义（传给 LLM） */
  tools?: ToolDefinition[];
  /** 最大 token 数，默认 4096 */
  maxTokens?: number;
  /** 内层循环：tool use 最大循环次数，每次外层迭代独立计数，默认 10 */
  maxToolRounds?: number;
  /** 外层循环：followUp 最大循环次数，默认 5 */
  maxFollowUpRounds?: number;
  /** 压缩配置（由 RuntimeApp 传入） */
  compaction?: CompactionConfig;
  /** 模型上下文窗口大小（由 RuntimeApp 从 config.llm.contextWindowTokens 传入），默认 200,000 */
  contextWindowTokens?: number;
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

/** 运行时事件 */
export type AgentEvent =
  | { type: 'run_start'; sessionKey: string; turnId: string }
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
  | { type: 'run_end'; sessionKey: string; turnId: string; result: RunResult }
  | { type: 'error'; sessionKey: string; turnId: string; error: Error }
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
      tokensBefore: number;
    }
  /** 压缩结束：摘要写入 session 后触发，包含压缩效果统计 */
  | {
      type: 'compaction_end';
      sessionKey: string;
      turnId: string;
      tokensBefore: number;
      tokensAfter: number;
      droppedMessages: number;
    };
