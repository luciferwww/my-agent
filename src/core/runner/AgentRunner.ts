import type { ChatMessage, ChatContentBlock, TokenUsage } from '../model-invocation/index.js';
import { AgentExecutionFailure } from './errors.js';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ContentBlock, MessageRecord } from '../session/types.js';
import type {
  AgentRunnerConfig,
  RunParams,
  RunResult,
  AgentEvent,
  ToolResult,
  PendingMessageReader,
  TurnContext,
} from './types.js';
import type {
  CanonicalToolResult,
  ToolExecutionContext,
  ToolCall,
  ToolDefinition,
  ToolResultOutcome,
} from '../tools/types.js';
import type { CompactionConfig } from '../../platform/config/types.js';
import { runBeforeToolCall, runAfterToolCall, runBeforeCompaction, runAfterCompaction } from './hooks/index.js';
import { pruneToolResults, pruneToolResultsAggregate } from './context/tool-result-pruning.js';
import { checkContextBudget } from './context/context-budget.js';
import { estimatePromptTokens } from './context/token-estimation.js';
import { ContextOverflowError } from './errors.js';
import { compactMessages } from './context/compaction.js';
import { Logger } from '../../platform/logger/index.js';

const logger = Logger.get('AgentRunner');

// ── 常量 ────────────────────────────────────────────────────

const DEFAULT_MAX_LLM_CALLS = 12;

/**
 * 外层压缩重试上限。
 * 每次 ContextOverflowError 触发一次 compactHistory + retry，
 * 超过此上限则将错误抛给调用方。
 */
const MAX_COMPACTION_RETRIES = 3;

/**
 * 内层循环 90% 阈值。
 * tool result 追加后，estimatedTokens 超过 contextWindow × 此值时，
 * 主动抛出 ContextOverflowError，避免等待 LLM API 报错。
 */
const INNER_LOOP_OVERFLOW_THRESHOLD = 0.9;

/** 默认压缩配置（调用方未传入时的占位值） */
const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTurns: 3,
  toolResultContextShare: 0.5,
  toolResultHeadChars: 10_000,
  toolResultTailChars: 5_000,
  timeoutSeconds: 300,
};

function isEmptyAbortedAssistant(record: MessageRecord): boolean {
  if (
    record.message.role !== 'assistant'
    || record.message.abortMeta?.partial !== true
  ) {
    return false;
  }
  return record.message.content.length === 0;
}

/**
 * Agent 执行引擎，串联所有模块完成一次完整的对话循环。
 *
 * 结构：run() 包裹外层压缩重试循环，runAttempt() 执行一次完整的对话尝试。
 *
 * 上下文管理（3 层）：
 *   Layer 1   - pruneToolResults：per-result 裁剪（不调 LLM，仅内存操作）
 *   Layer 1.5 - pruneToolResultsAggregate：聚合裁剪（truncate_tool_results_only 路由专用）
 *   Layer 2   - checkContextBudget：预判路由（fits / truncate_tool_results_only / compact）
 *   Layer 3   - compactHistory：LLM 摘要压缩（写入 session 持久化，需 retry）
 *
 * 溢出处理路径（均统一为 ContextOverflowError → 外层 retry）：
 *   1. runAttempt 开头预判：checkContextBudget 返回 'compact'
 *   2. 内层 90% 阈值检查：tool result 追加后 token 估算超限
 *   3. LLM API 被动兜底：callLLMStream 捕获 context overflow 类型 API 错误
 */
export class AgentRunner {
  private sessionManager: SessionManager;
  private onEvent?: (event: AgentEvent) => void;

  constructor(config: AgentRunnerConfig) {
    this.sessionManager = config.sessionManager;
    this.onEvent = config.onEvent;
  }

  /**
   * 净化会话末尾的孤立 trailing user 消息。
   *
   * 在 runAttempt / compactHistory 入口处调用，将上一次失败/中断遗留的
   * 末尾 user 消息从内存视图中剥离（branch 回其 parentId），使得后续的
   * loadHistory / append 不会看到这条孤儿。仅修改内存指针 leafId，不写
   * JSONL；被丢弃的 entry 仍然保留在文件里以供审计。
   *
   * 若末尾不是 user message（例如是 toolResult，说明 LLM 中途中断），
   * 仅 warn 记录，不主动修复 —— 这类破损需要更复杂的语义恢复策略。
   */
  private sanitizeSessionTail(turnCtx: TurnContext): void {
    const { sessionKey } = turnCtx;
    const records = this.sessionManager.getMessages(sessionKey);
    if (records.length === 0) return;

    const last = records[records.length - 1]!;
    if (last.message.role !== 'user') {
      if (last.message.role === 'toolResult') {
        logger.warn('[sanitizeSessionTail] session tail is toolResult (interrupted mid-tool-call); skipping cleanup', {
          sessionKey,
          entryId: last.id,
        });
      }
      return;
    }

    // 末尾是 user：回退到其 parentId（首条 user 时 parentId 指向 session 根记录）
    // SessionManager.branch() 只验证 byId.has(entryId)，session 根记录在 createSession
    // 时已被加入 byId，因此这里始终安全。
    const parentId = last.parentId;
    if (!parentId) {
      logger.warn('[sanitizeSessionTail] trailing user has no parentId; skipping', {
        sessionKey,
        entryId: last.id,
      });
      return;
    }

    this.sessionManager.branch(sessionKey, parentId);
    this.emit(turnCtx, {
      type: 'session_tail_sanitized',
      discardedEntryId: last.id,
      discardedRole: 'user',
    });
  }

  /**
   * 修复 session 末尾 assistant/user pair 里未被 tool_result 覆盖的 tool_use。
   *
   * 与 `sanitizeSessionTail` 平级：runAttempt 入口串行调用，把上一次遗留的
   * 磁盘破损修干净。详见 core-abort-spec.md §7.3。
   *
   * 覆盖来源：user abort、进程崩溃 / SIGKILL / 断电、未处理 exception、
   * 未来未知路径 Bug。判定基于**磁盘状态**（getMessages），天然规避 in-memory /
   * 磁盘不一致（例如 partial-assistant 写盘失败）。
   *
   * 内容文案：assistant.abortMeta?.partial === true → aborted 语义；
   * 否则 → recovered 语义（非 abort 来源）。
   *
   * try/catch 整包：写盘失败仅 log warn，不抛。未成功修复时下次 runAttempt
   * 再试；实在修不了时 LLM 调用会返回 API 400，属于 caller 可见的错误而
   * 非隐瞒崩溃。
   */
  private async repairOrphanToolUses(turnCtx: TurnContext): Promise<void> {
    const { sessionKey } = turnCtx;
    try {
      const records = this.sessionManager.getMessages(sessionKey);
      if (records.length === 0) return;

      const last = records[records.length - 1]!.message;
      let orphanIds: string[] = [];
      let hint: MessageRecord['message']['abortMeta'] | undefined;

      // 情况 A：末尾是 assistant 含 tool_use — 全部 tool_use 都是孤儿
      if (last.role === 'assistant' && Array.isArray(last.content)) {
        orphanIds = last.content
          .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((b) => b.id);
        hint = last.abortMeta;
      }
      // 情况 B：末尾是 toolResult，上一条 assistant 的 tool_use 对应不全
      // 【R9】包含 R6' 场景（tool 内部响应 signal 抛 AbortError 被 executeTool
      // swallow 为 isError=true 的 tool_result——已写入 tool_result，差集自然排除，
      // 不重复补写）
      else if (last.role === 'toolResult' && Array.isArray(last.content) && records.length >= 2) {
        const prev = records[records.length - 2]!.message;
        if (prev.role === 'assistant' && Array.isArray(prev.content)) {
          const useIds = new Set(
            prev.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
              .map((b) => b.id),
          );
          const resultIds = new Set(
            last.content
              .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
              .map((b) => b.tool_use_id),
          );
          orphanIds = [...useIds].filter((id) => !resultIds.has(id));
          hint = prev.abortMeta;
        }
      }

      if (orphanIds.length === 0) return;

      // 统一中性 synth 文案（参考 openclaw `repairToolUseResultPairing`），不假装
      // 区分成因。source 字段读 abortMeta 仅供 audit / test 断言，不驱动 content。
      // 详见 core-abort-spec.md §7.3。
      const source: 'abort' | 'recovered' = hint?.partial === true ? 'abort' : 'recovered';
      const content = '[tool call interrupted; session recovered]';
      const blocks: ContentBlock[] = orphanIds.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content,
      }));

      await this.sessionManager.appendMessage(sessionKey, {
        role: 'toolResult',
        content: blocks,
      });
      this.emit(turnCtx, {
        type: 'orphan_tool_results_repaired',
        count: orphanIds.length,
        source,
      });
    } catch (err) {
      logger.warn('[repairOrphanToolUses] repair failed; leaving session as-is', {
        sessionKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Abort 相关工具函数（详见 core-abort-spec.md §7.1） ─────

  /**
   * 名字判据：错误对象名字或 code 是否表明它是 abort 类型。callLLMStream /
   * runAttempt catch / `logIfSwallowedByAbortFallback` 三处复用，避免在多点
   * 重写同一份名字列表。
   *
   * 标准 DOMException + Node native fetch: name === 'AbortError'
   * Anthropic SDK 抛法（v0.82 实测）：把 upstream abort 包成 plain `Error`
   * (name === 'Error') with message === 'Request was aborted.'；名字判据无
   * 从识别，靠 message 精确匹配补上。将来若 SDK 换成 `APIUserAbortError`
   * 之类专有类名，可以把 message 匹配删除。
   */
  private isAbortByName(err: Error): boolean {
    return (
      err.name === 'AbortError'
      || err.name === 'APIUserAbortError'
      || (err as { code?: string }).code === 'ABORT_ERR'
      || err.message === 'Request was aborted.'
    );
  }

  /**
   * 判定 err 是否应按 abort 处理。用于 catch 分支决定"归 abort 优雅返回"
   * 还是"其他 error 上抛"。
   *
   * Fallback：SDK 升级或第三方 wrapper 可能吞掉 err.name。若调用方能提供
   * 关联 signal 且 signal.aborted === true，倾向按 abort 处理，避免 abort
   * 语义悄悄退化成 'error' 停止原因。调用点凡是拿得到 signal 都应传入。
   *
   * 【副作用，读者必知】本 fallback 是粗粒度的——**只要 signal 已 abort，任何
   * error 都会被归到 abort 分支**，包括与 abort 无关的 IO error / TypeError /
   * 其他 Bug 引发的 exception。这是主动取舍：§4 "never throws" 优先于 "错误
   * 类型保真"——宁可丢失非-abort error 的具体类型（降为 stopReason='aborted'
   * 返回），也不能让 abort 路径抛错。
   *
   * 【诊断兜底】fallback 命中的非-abort error 必须在调用方 catch 里显式
   * 写一条 warn log（见 `logIfSwallowedByAbortFallback`，在 catch 点调用）——
   * 否则内部 Bug 会被完全静默，无法从 stopReason='aborted' 反推真相。
   */
  private isAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (!(err instanceof Error)) return false;
    if (this.isAbortByName(err)) return true;
    if (signal?.aborted) return true;
    return false;
  }

  /**
   * 当 `isAbortError` 返回 true 但 err 并非 abort 名字（仅被 signal fallback
   * 兜进来）时，写一条 warn log。runAttempt 外层 catch 与 callLLMStream catch
   * 两处复用。
   */
  private logIfSwallowedByAbortFallback(err: unknown, sessionKey: string): void {
    if (err instanceof Error && !this.isAbortByName(err)) {
      logger.warn('non-abort error swallowed by abort fallback', {
        sessionKey,
        errName: err.name,
        errMessage: err.message,
      });
    }
  }

  /**
   * 构造 abort 时的返回值。返回 `Omit<RunResult, 'compacted'>`，run() 顶层
   * 负责拼 compacted flag（与现有正常路径一致）。
   *
   * `lastContent` 传空数组表示"还没跑过任何 LLM 调用"（run() 顶层 signal.aborted
   * 早退路径）；否则传出 catch/aborted 分支时的最后一条 assistant content。
   *
   * `accumulated`：runAttempt 在 abort 命中之前已跑过 N 轮 LLM/tool 调用，
   * 那些 usage 早已被 Anthropic 计费、tool rounds 也真实发生。abort 路径
   * 必须把截止时刻的累计值传上来，否则 telemetry / cost 追踪会以为这一
   * turn 免费——违反 audit 完整性。顶层 signal.aborted 早退路径可省略
   * （默认 {0,0}/0），因为那条路径下一次 LLM 调用都没发生。
   */
  private buildAbortedResult(
    lastContent: ChatContentBlock[],
    accumulated?: { usage: TokenUsage; toolRounds: number },
  ): Omit<RunResult, 'compacted'> {
    return {
      text: this.extractText(lastContent),
      content: lastContent,
      stopReason: 'aborted',
      usage: accumulated?.usage ?? { inputTokens: 0, outputTokens: 0 },
      toolRounds: accumulated?.toolRounds ?? 0,
    };
  }

  // ── 公共入口 ─────────────────────────────────────────────

  async run(params: RunParams): Promise<RunResult> {
    const contextWindowTokens = params.resolvedModel.facts.effectiveContextLimit.value;
    const compaction = params.compaction ?? DEFAULT_COMPACTION_CONFIG;

    // emit 上下文沿调用链显式透传：消除"实例字段保存当前 run"的隐式状态，
    // Child executor 嵌套 run() / 任何并发 run() 都不会互相串号事件。
    const turnCtx: TurnContext = {
      sessionKey: params.sessionKey,
      turnId: params.turnId,
      requestId: params.requestId ?? params.turnId,
    };

    this.emit(turnCtx, { type: 'run_start', originMessageId: params.originMessageId });

    // 顶层快速检查：入口就被 abort 时直接返回，不做任何 LLM 调用。
    // run_start 已先发，此处发 run_end 保证事件对完整。
    // usage/toolRounds 天然为 0（此路径下未跑任何调用），用 buildAbortedResult 默认值。
    // 详见 core-abort-spec.md §7.1。
    if (params.signal?.aborted) {
      const finalResult: RunResult = {
        ...this.buildAbortedResult([]),
        compacted: false,
      };
      this.emit(turnCtx, { type: 'run_end', result: finalResult });
      return finalResult;
    }

    // 注意：用户消息的 append 已下沉到 runAttempt() 内部，在 Layer 2 preflight
    // 通过之后才写入；这样 ContextOverflowError → compactHistory 重试期间，
    // 当前 user 消息不会污染待压缩的历史，也不会被重复写入。

    let compactionAttempts = 0;
    let compacted = false;

    // 外层压缩重试循环：捕获 ContextOverflowError，压缩 session 后重试
    while (true) {
      try {
        const result = await this.runAttempt(turnCtx, params, contextWindowTokens, compaction);
        const finalResult: RunResult = { ...result, compacted };
        this.emit(turnCtx, { type: 'run_end', result: finalResult });
        return finalResult;
      } catch (err) {
        // Abort 防御性优先分支（core-abort-spec.md §4 "abort never throws"）：
        // 正常情况下 runAttempt 内部已把 abort 消化为 stopReason='aborted' 返回，
        // 不会抛到这里；本分支兜底两类罕见路径：
        //  (a) runAttempt 因 ContextOverflow 抛出，但期间 signal 已 abort
        //  (b) 下面 compactHistory 里的 LLM 调用被 abort（见嵌套 catch）
        if (this.isAbortError(err, params.signal)) {
          this.logIfSwallowedByAbortFallback(err, params.sessionKey);
          const finalResult: RunResult = {
            ...this.buildAbortedResult([]),
            compacted,
          };
          this.emit(turnCtx, { type: 'run_end', result: finalResult });
          return finalResult;
        }

        if (err instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
          logger.info('compaction retry triggered', {
            sessionKey: params.sessionKey,
            turnId: params.turnId,
            trigger: err.trigger,
            attempt: compactionAttempts + 1,
            maxAttempts: MAX_COMPACTION_RETRIES,
            reason: err.message,
          });
          // 执行 LLM 摘要压缩，写入持久化，然后重试 runAttempt
          // runAttempt 的 loadHistory() 会重新加载压缩后的 session，自动感知摘要
          try {
            await this.compactHistory(turnCtx, params, compaction, err.trigger);
          } catch (compactErr) {
            // compactHistory 内部 LLM 调用若被 abort，走 §4 兜底：clean return aborted。
            if (this.isAbortError(compactErr, params.signal)) {
              this.logIfSwallowedByAbortFallback(compactErr, params.sessionKey);
              const finalResult: RunResult = {
                ...this.buildAbortedResult([]),
                compacted,
              };
              this.emit(turnCtx, { type: 'run_end', result: finalResult });
              return finalResult;
            }
            throw compactErr;
          }
          compacted = true;
          compactionAttempts++;
          continue;
        }

        // 超过重试上限，或非 ContextOverflowError → 向上抛出
        const error = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ContextOverflowError) {
          logger.error('compaction retries exhausted', {
            sessionKey: params.sessionKey,
            turnId: params.turnId,
            attempts: compactionAttempts,
            maxAttempts: MAX_COMPACTION_RETRIES,
            reason: err.message,
          });
        }
        this.emit(turnCtx, { type: 'error', error });
        throw error;
      }
    }
  }

  // ── 单次运行尝试 ──────────────────────────────────────────

  /**
   * 执行一次完整的对话尝试（不含外层 retry 逻辑）。
   *
   * 每次 compactHistory 后重新调用此方法，loadHistory() 会加载压缩后的历史，
   * 从而"看到"摘要消息而非原始的全量历史。
   */
  private async runAttempt(
    turnCtx: TurnContext,
    params: RunParams,
    contextWindowTokens: number,
    compaction: CompactionConfig,
  ): Promise<Omit<RunResult, 'compacted'>> {
    const maxLlmCalls = params.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
    const turnSignal = params.signal ?? new AbortController().signal;

    // 0. 净化会话末尾的孤立 trailing user（来自上一次失败/中断的遗留）
    this.sanitizeSessionTail(turnCtx);

    // 0'. 修复末尾 assistant/user pair 里未被 tool_result 覆盖的 tool_use
    //     （抗 abort / 崩溃 / kill / 未知 Bug，从磁盘状态出发）
    //     详见 core-abort-spec.md §7.3。
    await this.repairOrphanToolUses(turnCtx);

    // 1. 加载历史消息（不含当前用户消息）
    //    若 session 有压缩记录，loadHistory 会自动截断并注入摘要
    let messages: ChatMessage[] = this.loadHistory(params.sessionKey);

    // 2. Layer 1: per-result 裁剪（仅操作历史消息，不触碰当前用户消息）
    if (compaction.enabled) {
      messages = pruneToolResults(messages, compaction, contextWindowTokens, (info) => {
        this.emit(turnCtx, {
          type: 'tool_result_pruned',
          toolUseId: info.toolUseId ?? `index:${info.index}`,
          originalChars: info.originalChars,
          prunedChars: info.prunedChars,
        });
      });
    }

    // 3. Layer 2: 预判检测与路由
    //    messages 此时不含当前用户消息；currentPrompt 独立传入，不会被压缩
    if (compaction.enabled) {
      const budget = checkContextBudget({
        messages,
        systemPrompt: params.systemPrompt,
        currentPrompt: params.message,
        contextWindowTokens,
        config: compaction,
      });

      logger.debug('context budget route', {
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        route: budget.route,
        estimatedTokens: budget.estimatedTokens,
        availableTokens: budget.availableTokens,
      });

      if (budget.route === 'truncate_tool_results_only') {
        // Layer 1.5: 聚合裁剪，将所有 tool result 总量压入聚合预算（不调 LLM）
        messages = pruneToolResultsAggregate(messages, contextWindowTokens, compaction);
      } else if (budget.route === 'compact') {
        // 预判发现需要 LLM 摘要压缩，抛出给外层 retry 循环处理
        throw new ContextOverflowError(
          `Preemptive compaction required: estimated ${budget.estimatedTokens} tokens `
          + `exceeds budget ${budget.availableTokens} tokens`,
          'preemptive',
        );
      }
      // route === 'fits' → 直接继续
    }

    // 4. preflight 通过 → 此时才将本次 user 消息持久化到 session
    //    并 append 进 messages 进入主循环。
    //    顺序：先 append 到 session（持久化）再 push 到 messages（内存）。
    //    若 ContextOverflowError 抛出在 preflight 之前，则 session 不会被污染。
    await this.sessionManager.appendMessage(params.sessionKey, {
      role: 'user',
      content: params.message,
    });
    messages = [...messages, { role: 'user', content: params.message }];

    // 5. 主循环：LLM 调用 + tool use
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalToolRounds = 0;
    let lastContent: ChatContentBlock[] = [];
    let lastStopReason = 'end_turn';
    let llmCallCount = 0;
    let hasMoreToolCalls = true; // 初始 true，保证至少一次 LLM 调用
    let pendingSteeringMessages: ChatMessage[] = [];

    try {
      while (hasMoreToolCalls || pendingSteeringMessages.length > 0) {
        // ∅ 每个 LLM 调用前 abort check（core-abort-spec.md §7.2）
        //
        // 若此时 pendingSteeringMessages 里有已 drain 但未注入的 steering 消息：
        // 丢弃（不写 session，不回填 inbox）。与 D3 "abort 清空 queue" 语义一致。
        // 该丢弃仅写 log，不 emit event——触发窗口极窄、count 实际多为 0 或 1，
        // 而 messages_dropped event 产生点在 RuntimeApp.abortTurn，那里拿不到
        // runAttempt 局部变量。运维只需 log grep 即可回溯。
        if (params.signal?.aborted) {
          if (pendingSteeringMessages.length > 0) {
            logger.info('dropped pending steering on abort', {
              sessionKey: params.sessionKey,
              count: pendingSteeringMessages.length,
            });
          }
          throw new DOMException('Aborted', 'AbortError');
        }

        if (llmCallCount >= maxLlmCalls) {
          const text = this.extractText(lastContent);
          return {
            text,
            content: lastContent,
            stopReason: 'max_llm_calls',
            usage: totalUsage,
            toolRounds: totalToolRounds,
          };
        }

        // 注入上一轮积累的 steering 消息（LLM 调用前，保证 tool_result 在前、steering 在后）
        if (pendingSteeringMessages.length > 0) {
          await this.appendInjectedMessages(params.sessionKey, messages, pendingSteeringMessages);
          pendingSteeringMessages = [];
        }

        this.emit(turnCtx, { type: 'llm_call', round: llmCallCount });
        llmCallCount++;

        // 流式调用 LLM（内部捕获 API 级别的 context overflow 错误 + abort）
        const llmResult = await this.callLLMStream(turnCtx, {
          system: params.systemPrompt,
          messages,
          tools: [...params.toolProjection.visibleDefinitions(params.toolPolicy)],
        }, params.resolvedModel, params.signal);

        totalUsage = {
          inputTokens: totalUsage.inputTokens + llmResult.usage.inputTokens,
          outputTokens: totalUsage.outputTokens + llmResult.usage.outputTokens,
        };

        lastContent = llmResult.content;
        lastStopReason = llmResult.stopReason;

        // ⑰ Partial stream 分支：callLLMStream 优雅返回 stopReason='aborted'
        //
        // 【前提不变量】本分支进入时 params.signal.aborted === true：callLLMStream
        // 仅在 isAbortError=true 时返回 'aborted'，而在本项目中真 AbortError 只从
        // 外部触发一 controller.abort() 产生（signal 已 flip）。未来若放宽
        // callLLMStream 返回 'aborted' 的触发条件（例如 SDK 内部 timeout 也走
        // AbortError），此不变量会失效，需在本处重新审视 IO 抛错处理。
        //
        // 只有已收到内容时才持久化 partial assistant；首个内容前中止时保留 trailing
        // user，下一 turn 由 sanitizeSessionTail 剥离。不得写入 Provider 会拒绝的空
        // assistant content。
        //
        // appendMessage 同其他调用点一致，不为 abort 路径特化错误处理：若 IO 抛出，
        // 依靠 §7.1 isAbortError fallback（signal.aborted 为真）将其归入 abort 分支，
        // §4 "never throws" 仍成立——前提不变量失效时本保障同时失效。
        //
        // 孤儿 tool_use 不在本处处理：下一 turn 起点的 repairOrphanToolUses 会从
        // 磁盘状态统一修（§7.3），避免与 in-memory / IO 失败纠缠。
        if (lastStopReason === 'aborted') {
          if (llmResult.content.length > 0) {
            messages.push({ role: 'assistant', content: llmResult.content });
            await this.sessionManager.appendMessage(params.sessionKey, {
              role: 'assistant',
              content: llmResult.content,
              abortMeta: { partial: true, stopReason: 'aborted' },
            });
          }
          return this.buildAbortedResult(lastContent, {
            usage: totalUsage,
            toolRounds: totalToolRounds,
          });
        }

        messages.push({ role: 'assistant', content: llmResult.content });

        await this.sessionManager.appendMessage(params.sessionKey, {
          role: 'assistant',
          content: llmResult.content,
        });

        // error → 提前返回（aborted 已在上面 ⑰ 分支处理，此处仅剩 error）
        if (lastStopReason === 'error') {
          const text = this.extractText(lastContent);
          return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
        }

        const toolUseBlocks = llmResult.toolCalls;

        if (toolUseBlocks.length === 0) {
          // 没有 tool calls → 退出循环
          hasMoreToolCalls = false;
        } else {
          // 执行工具
          const toolResultBlocks: ChatContentBlock[] = [];
          const afterToolCallSettlements: Promise<unknown>[] = [];
          for (const toolUse of toolUseBlocks) {
            // Event schema migration is outside Slice 3; retain the existing event shape.
            const eventInput = toolUse.input.state === 'ready' ? toolUse.input.value : {};
            this.emit(turnCtx, { type: 'tool_use', name: toolUse.name, input: eventInput });

            const execution = turnSignal.aborted
              ? {
                  result: this.canonicalToolResult(
                    toolUse.callId,
                    'not_executed',
                    `Tool "${toolUse.name}" was not executed because the Turn was aborted.`,
                  ),
                  effectiveInput: eventInput,
                  implementationStarted: false,
                }
              : await this.executeCanonicalToolCall(toolUse, params, turnSignal);

            const legacyResult = this.toLegacyToolResult(execution.result);
            this.emit(turnCtx, { type: 'tool_result', name: toolUse.name, result: legacyResult });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.callId,
              content: execution.result.content,
            });

            if (params.hookProjection.afterToolCall.length > 0) {
              afterToolCallSettlements.push(runAfterToolCall(params.hookProjection.afterToolCall, {
                toolName: toolUse.name,
                input: execution.effectiveInput,
                result: execution.result,
                durationMs: execution.durationMs,
                implementationStarted: execution.implementationStarted,
                turnId: params.turnId,
                sessionKey: params.sessionKey,
              }, turnSignal));
            }
          }

          // toolResult push 到 messages（Anthropic API 格式：role=user）
          messages.push({ role: 'user', content: toolResultBlocks });

          try {
            await this.sessionManager.appendMessage(params.sessionKey, {
              role: 'toolResult',
              content: toolResultBlocks,
            });
          } finally {
            await Promise.all(afterToolCallSettlements);
          }

          if (turnSignal.aborted) {
            pendingSteeringMessages = await this.readPendingMessages(params.getSteeringMessages);
            if (pendingSteeringMessages.length > 0) {
              logger.info('dropped pending steering on abort', {
                sessionKey: params.sessionKey,
                count: pendingSteeringMessages.length,
              });
            }
            return this.buildAbortedResult(lastContent, {
              usage: totalUsage,
              toolRounds: totalToolRounds,
            });
          }

          // Layer 1: 新 tool result 追加后做 per-result 裁剪
          if (compaction.enabled) {
            messages = pruneToolResults(messages, compaction, contextWindowTokens);
          }

          // 90% 阈值检查：主动检测，避免等待 LLM API 报错
          if (compaction.enabled) {
            const estimated = estimatePromptTokens({ messages, systemPrompt: params.systemPrompt });
            if (estimated > contextWindowTokens * INNER_LOOP_OVERFLOW_THRESHOLD) {
              logger.warn('inner-loop overflow threshold breached', {
                sessionKey: params.sessionKey,
                turnId: params.turnId,
                estimatedTokens: estimated,
                contextWindowTokens,
                thresholdPct: INNER_LOOP_OVERFLOW_THRESHOLD * 100,
              });
              throw new ContextOverflowError(
                `Context exceeds ${INNER_LOOP_OVERFLOW_THRESHOLD * 100}% threshold during tool loop `
                + `(estimated ${estimated} of ${contextWindowTokens} tokens)`,
              );
            }
          }

          totalToolRounds++;
        }

        // 每轮结束后检查 steering 消息（无论有无 tool call），留给下次迭代的 LLM 调用前注入。
        pendingSteeringMessages = await this.readPendingMessages(params.getSteeringMessages);
      }

      const text = this.extractText(lastContent);
      return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
    } catch (err) {
      // Abort 出口：不修孤儿（§7.3 turn 起点会从磁盘统一修），只专注"优雅返回 aborted"。
      // 详见 core-abort-spec.md §7.1 R1 / §7.2 分支 (2)。
      if (this.isAbortError(err, params.signal)) {
        // 【fallback 诊断 log】若命中仅因 signal.aborted fallback（非 abort 名字），
        // 写条 warn 使 §7.1 "错误内容在 log 里可见" 的兑现属实。
        this.logIfSwallowedByAbortFallback(err, params.sessionKey);
        return this.buildAbortedResult(lastContent, {
          usage: totalUsage,
          toolRounds: totalToolRounds,
        });
      }
      if (err instanceof ContextOverflowError || err instanceof AgentExecutionFailure) {
        throw err;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      throw new AgentExecutionFailure(error.message, totalUsage, { cause: error });
    }
  }

  // ── 压缩 ──────────────────────────────────────────────────

  /**
   * 对 session 历史执行 LLM 摘要压缩，并将结果写入持久化。
   *
   * 流程：
   *   1. 加载当前历史消息（同 runAttempt 的 loadHistory）
   *   2. 调用 compactMessages 生成摘要（LLM 调用，失败时降级为兜底文本）
   *   3. 将 CompactionRecord 写入 JSONL（appendCompactionRecord）
   *   4. 发出 compaction_start / compaction_end 事件
   *
   * 写入后，下次 runAttempt 的 loadHistory() 会检测到压缩记录，
   * 自动截断历史（只取 firstKeptEntryId 之后的消息）并注入摘要。
   *
   * @param trigger 触发原因（'preemptive' | 'overflow' | 'manual'）
   */
  private async compactHistory(
    turnCtx: TurnContext,
    params: RunParams,
    compaction: CompactionConfig,
    trigger: 'preemptive' | 'overflow' | 'manual',
  ): Promise<void> {
    // 0. 净化会话末尾的孤立 trailing user（同 runAttempt 入口）
    //    若 preemptive 触发：runAttempt 已先净化，此处 no-op。
    //    若 overflow 触发：runAttempt 已 append 过 user，此处需要把这条剥离，
    //    避免它进入 compactMessages 的输入。
    this.sanitizeSessionTail(turnCtx);

    // 加载当前历史消息（用于压缩，不含当前用户消息）
    const messages = this.loadHistory(params.sessionKey);
    const estimatedTokens = estimatePromptTokens({ messages });
    const turnSignal = params.signal ?? new AbortController().signal;

    if (params.hookProjection.beforeCompaction.length > 0) {
      await runBeforeCompaction(params.hookProjection.beforeCompaction, {
        trigger,
        estimatedTokens,
        turnId: params.turnId,
        sessionKey: params.sessionKey,
      }, turnSignal);
      if (turnSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    }

    this.emit(turnCtx, { type: 'compaction_start', trigger, estimatedTokens });

    // 执行 LLM 摘要压缩
    const compactResult = await compactMessages({
      messages,
      config: compaction,
      llmClient: params.resolvedModel.invocationPort,
      model: params.resolvedModel.identity.modelId,
      maxTokens: params.resolvedModel.limits.maxTokens,
      trigger,
    });

    // 找到保留区第一条消息在 session 中的 ID，用于 firstKeptEntryId
    // 保留区消息数 = compactResult.messages.length - 1（减去摘要消息）
    const keptCount = compactResult.messages.length - 1; // 不含摘要消息
    const allMessages = this.sessionManager.getMessages(params.sessionKey);
    // 保留区从全量历史的末尾倒数 keptCount 条开始
    const firstKeptIndex = Math.max(0, allMessages.length - keptCount);
    const firstKeptEntryId = allMessages[firstKeptIndex]?.id ?? allMessages[0]?.id ?? '';

    // 将压缩记录写入 JSONL 并更新 session 元数据
    await this.sessionManager.appendCompactionRecord(
      params.sessionKey,
      compactResult.record,
      firstKeptEntryId,
    );

    logger.info('compaction wrote record', {
      sessionKey: params.sessionKey,
      turnId: params.turnId,
      trigger,
      firstKeptEntryId,
      tokensBefore: compactResult.stats.tokensBefore,
      tokensAfter: compactResult.stats.tokensAfter,
      droppedMessages: compactResult.stats.droppedMessages,
    });

    if (params.hookProjection.afterCompaction.length > 0) {
      await runAfterCompaction(params.hookProjection.afterCompaction, {
        trigger,
        tokensBefore: compactResult.stats.tokensBefore,
        tokensAfter: compactResult.stats.tokensAfter,
        droppedMessages: compactResult.stats.droppedMessages,
        turnId: params.turnId,
        sessionKey: params.sessionKey,
      }, turnSignal);
    }

    this.emit(turnCtx, {
      type: 'compaction_end',
      tokensBefore: compactResult.stats.tokensBefore,
      tokensAfter: compactResult.stats.tokensAfter,
      droppedMessages: compactResult.stats.droppedMessages,
    });

    // 同步更新 session 的 totalTokens 元数据
    await this.sessionManager.updateSession(params.sessionKey, {
      totalTokens: compactResult.stats.tokensAfter,
    });
  }

  // ── 历史加载（感知压缩记录） ─────────────────────────────

  /**
   * 从 session 加载历史消息，转换为 llm-client 的 ChatMessage 格式。
   *
   * 若 session 有压缩记录，则：
   *   1. 只取 firstKeptEntryId 之后（含）的消息（截断旧历史）
   *   2. 在最前面插入一条摘要消息（使 LLM 能感知被压缩的历史内容）
   *
   * toolResult role 转换为 user role（对齐 Anthropic API）。
   */
  private loadHistory(sessionKey: string): ChatMessage[] {
    const records = this.sessionManager.getMessages(sessionKey);

    // 检查是否有压缩记录
    const compactionRecord = this.sessionManager.getLastCompactionRecord(sessionKey);

    let effectiveRecords = records;
    if (compactionRecord) {
      // 找到保留区起点，只取该点之后的消息
      const keptIndex = records.findIndex((r) => r.id === compactionRecord.firstKeptEntryId);
      if (keptIndex >= 0) {
        effectiveRecords = records.slice(keptIndex);
      }
    }

    // 转换为 ChatMessage 格式。旧版本可能在首个内容前中止时持久化空的
    // aborted assistant；保留磁盘审计记录，但不把无效 content 发给 Provider。
    const messages: ChatMessage[] = effectiveRecords
      .filter((record) => !isEmptyAbortedAssistant(record))
      .map((record: MessageRecord) => {
        if (record.message.role === 'toolResult') {
          return { role: 'user' as const, content: record.message.content };
        }
        return {
          role: record.message.role as 'user' | 'assistant',
          content: record.message.content,
        };
      });

    // 在最前面注入摘要消息（让 LLM 了解被压缩的历史）
    if (compactionRecord) {
      messages.unshift({
        role: 'user',
        content: `[Previous conversation summary]\n\n${compactionRecord.summary}\n\n[End of summary. The conversation continues below.]`,
      });
    }

    return messages;
  }

  // ── 内部方法 ──────────────────────────────────────────────

  /**
   * 流式调用 LLM，一边触发 onEvent 一边收集结果。
   *
   * 额外处理：
   *  - 捕获 LLM API 返回的 context overflow 类型错误，包装成 ContextOverflowError
   *    向上抛出，使外层 retry 循环能统一处理。
   *  - 捕获 abort（SDK 抛 AbortError 或 signal.aborted fallback）：flush 已 buffered
   *    的 text，返回 `stopReason='aborted'`（不抛），由 runAttempt 走 partial stream
   *    分支处理（core-abort-spec.md §7.2 分支 (1)）。
   *
   * 关于 R8（残缺 tool_use 过滤）：AnthropicClient 只在 `content_block_stop` 事件
   * 时才 yield 完整的 `tool_use`（含 parsed input），未完成的块自然不会出现在
  * ModelStreamEvent 里。因此 contentBlocks 里的 tool_use 一定是完整的，无需额外过滤。
   */
  private async callLLMStream(
    turnCtx: TurnContext,
    params: {
      system?: string;
      messages: ChatMessage[];
      tools?: ToolDefinition[];
    },
    resolvedModel: ResolvedModel,
    signal?: AbortSignal,
  ): Promise<{
    content: ChatContentBlock[];
    toolCalls: ToolCall[];
    stopReason: string;
    usage: TokenUsage;
  }> {
    const contentBlocks: ChatContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const toolCallIds = new Set<string>();
    let currentText = '';
    let stopReason = 'end_turn';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const event of resolvedModel.invocationPort.chatStream({
        model: resolvedModel.identity.modelId,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        maxTokens: resolvedModel.limits.maxTokens,
        signal,
      })) {
        switch (event.type) {
          case 'text_delta':
            currentText += event.text;
            this.emit(turnCtx, { type: 'text_delta', text: event.text });
            break;

          case 'tool_call':
            if (event.call.callId.trim() === '' || event.call.name.trim() === '') {
              throw new Error('Canonical Tool Call id and name must be non-empty.');
            }
            if (toolCallIds.has(event.call.callId)) {
              throw new Error(`Duplicate canonical Tool Call id "${event.call.callId}".`);
            }
            toolCallIds.add(event.call.callId);
            if (currentText) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            toolCalls.push(event.call);
            contentBlocks.push({
              type: 'tool_use',
              id: event.call.callId,
              name: event.call.name,
              input: event.call.input.state === 'ready' ? { ...event.call.input.value } : {},
            });
            break;

          case 'message_end':
            stopReason = event.stopReason;
            usage = event.usage;
            break;

          case 'error':
            throw event.error;
        }
      }
    } catch (err) {
      // Abort 优先判定（在 ContextOverflow 之前）：signal 已 flip / 名字匹配即走 aborted 返回。
      // 不 rethrow：由 runAttempt 的 ⑰ 分支处理 partial assistant + abortMeta 持久化。
      if (this.isAbortError(err, signal)) {
        this.logIfSwallowedByAbortFallback(err, turnCtx.sessionKey);
        // flush 已 buffered 的 currentText 到 contentBlocks（tool_use 已在 content_block_stop
        // 时被 AnthropicClient yield，contentBlocks 里天然只含完整块，无需 R8 过滤）
        if (currentText) {
          contentBlocks.push({ type: 'text', text: currentText });
        }
        return {
          content: contentBlocks,
          toolCalls,
          stopReason: 'aborted',
          usage, // 中断发生在 message_end 之前 → {0,0}（best-effort，Anthropic API 已计费但 SDK 未返回）
        };
      }
      throw err;
    }

    if (currentText) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    return { content: contentBlocks, toolCalls, stopReason, usage };
  }

  private async executeCanonicalToolCall(
    toolUse: ToolCall,
    params: RunParams,
    turnSignal: AbortSignal,
  ): Promise<{
    result: CanonicalToolResult;
    effectiveInput: Record<string, unknown>;
    implementationStarted: boolean;
    durationMs?: number;
  }> {
    if (toolUse.input.state === 'invalid') {
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          'invalid_input',
          `Invalid input for tool "${toolUse.name}": ${toolUse.input.reason}.`,
        ),
        effectiveInput: {},
        implementationStarted: false,
      };
    }

    const resolvedTool = params.toolProjection.resolve(toolUse.name);
    if (!resolvedTool) {
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          'unknown_tool',
          `Unknown tool: "${toolUse.name}".`,
        ),
        effectiveInput: { ...toolUse.input.value },
        implementationStarted: false,
      };
    }

    let effectiveInput = { ...toolUse.input.value };
    try {
      const beforeResult = await runBeforeToolCall(params.hookProjection.beforeToolCall, {
        toolName: toolUse.name,
        input: effectiveInput,
        turnId: params.turnId,
        sessionKey: params.sessionKey,
        signal: turnSignal,
      });
      effectiveInput = beforeResult.input;
      if (beforeResult.action === 'deny') {
        return {
          result: this.canonicalToolResult(
            toolUse.callId,
            'denied',
            `Tool blocked: ${beforeResult.reason}`,
          ),
          effectiveInput,
          implementationStarted: false,
        };
      }
    } catch (error) {
      const outcome: ToolResultOutcome = this.isAbortError(error, turnSignal)
        ? 'aborted'
        : 'failed';
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          outcome,
          `Tool interceptor failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    const validation = resolvedTool.validator.validate(effectiveInput);
    if (!validation.valid) {
      const details = validation.errors
        .map((error) => `${error.instancePath || '/'} ${error.message}`)
        .join('; ');
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          'invalid_input',
          `Invalid input for tool "${toolUse.name}": ${details}`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    const policyDecision = params.toolPolicy.decide(
      toolUse.name,
      params.approvalCapability !== undefined,
    );
    if (policyDecision === 'deny') {
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          'denied',
          `Tool "${toolUse.name}" is denied by Application policy.`,
        ),
        effectiveInput,
        implementationStarted: false,
      };
    }

    if (policyDecision === 'requires_approval') {
      try {
        const approval = await params.approvalCapability!.request({
          callId: toolUse.callId,
          toolName: toolUse.name,
          input: effectiveInput,
          sessionKey: params.sessionKey,
          turnId: params.turnId,
        }, turnSignal);
        if (approval.outcome !== 'approved') {
          const outcome: ToolResultOutcome = approval.outcome === 'aborted'
            ? 'aborted'
            : approval.outcome === 'unavailable'
              ? 'unavailable'
              : approval.outcome === 'failed'
                ? 'failed'
                : 'denied';
          const reason = approval.outcome === 'failed'
            ? approval.message
            : approval.reason;
          return {
            result: this.canonicalToolResult(
              toolUse.callId,
              outcome,
              `Tool approval ${approval.outcome}: ${reason}.`,
            ),
            effectiveInput,
            implementationStarted: false,
          };
        }
      } catch (error) {
        const outcome: ToolResultOutcome = this.isAbortError(error, turnSignal)
          ? 'aborted'
          : 'failed';
        return {
          result: this.canonicalToolResult(
            toolUse.callId,
            outcome,
            `Tool approval failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
          effectiveInput,
          implementationStarted: false,
        };
      }
    }

    const startTime = Date.now();
    const toolContext: ToolExecutionContext = {
      sessionKey: params.sessionKey,
      turnId: params.turnId,
      callId: toolUse.callId,
      signal: turnSignal,
    };
    try {
      const result = await resolvedTool.execute(effectiveInput, toolContext);
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          result.outcome,
          result.content,
        ),
        effectiveInput,
        implementationStarted: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const outcome: ToolResultOutcome = this.isAbortError(error, turnSignal)
        ? 'aborted'
        : 'failed';
      return {
        result: this.canonicalToolResult(
          toolUse.callId,
          outcome,
          `Error executing tool "${toolUse.name}": ${error instanceof Error ? error.message : String(error)}`,
        ),
        effectiveInput,
        implementationStarted: true,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private canonicalToolResult(
    callId: string,
    outcome: ToolResultOutcome,
    content: string,
  ): CanonicalToolResult {
    return Object.freeze({ callId, outcome, content });
  }

  private toLegacyToolResult(result: CanonicalToolResult): ToolResult {
    return {
      content: result.content,
      isError: result.outcome !== 'success',
    };
  }

  /** 从 content blocks 中提取纯文本 */
  private extractText(content: ChatContentBlock[]): string {
    return content
      .filter((b): b is Extract<ChatContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  private async appendInjectedMessages(
    sessionKey: string,
    targetMessages: ChatMessage[],
    injectedMessages: ChatMessage[],
  ): Promise<void> {
    for (const message of injectedMessages) {
      targetMessages.push(message);
      await this.sessionManager.appendMessage(sessionKey, {
        role: message.role,
        content: message.content,
      });
    }
  }

  private async readPendingMessages(reader?: PendingMessageReader): Promise<ChatMessage[]> {
    if (!reader) {
      return [];
    }

    const result = await reader();
    if (!Array.isArray(result)) {
      return [];
    }

    return result.filter((message): message is ChatMessage => {
      if (!message || typeof message !== 'object') {
        return false;
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        return false;
      }
      return Object.hasOwn(message, 'content');
    });
  }

  /**
   * 发出 AgentEvent。turnCtx 显式由调用方提供，AgentRunner 自身不持有
   * "当前 run 是哪个"的状态——这让嵌套 / 并发 run() 都能正确标签事件。
   */
  private emit(turnCtx: TurnContext, event: AgentEventInput): void {
    if (!this.onEvent) return;
    const correlated = event.type === 'run_start'
      || event.type === 'run_end'
      || event.type === 'error';
    this.onEvent({
      ...event,
      sessionKey: turnCtx.sessionKey,
      turnId: turnCtx.turnId,
      ...(correlated ? { requestId: turnCtx.requestId } : {}),
    } as AgentEvent);
  }
}

/**
 * AgentRunner 内部 emit 的输入类型：每个 AgentEvent 变体去掉 sessionKey/turnId
 * 后的形式。使用条件类型分发，确保每个变体保留各自的 discriminator 字段。
 * sessionKey/turnId 由 emit 从显式传入的 TurnContext 注入，调用方不必手动填。
 */
type AgentEventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'sessionKey' | 'turnId' | 'requestId'>
    : never
  : never;
