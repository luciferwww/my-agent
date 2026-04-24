import type { LLMClient, ChatMessage, ChatContentBlock, TokenUsage } from '../llm-client/types.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { MessageRecord } from '../session/types.js';
import type {
  AgentRunnerConfig,
  RunParams,
  RunResult,
  AgentEvent,
  ToolResult,
  ToolExecutor,
} from './types.js';
import type { CompactionConfig } from '../config/types.js';
import type { HookName, HookHandlerMap, HookRegistration } from './hooks/index.js';
import { runBeforeToolCall, runAfterToolCall } from './hooks/index.js';
import { pruneToolResults, pruneToolResultsAggregate } from './tool-result-pruning.js';
import { checkContextBudget } from './context-budget.js';
import { estimatePromptTokens } from './token-estimation.js';
import { ContextOverflowError, isContextOverflowError } from './errors.js';
import { compactMessages } from './compaction.js';

// ── 常量 ────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOOL_ROUNDS = 10;
const DEFAULT_MAX_FOLLOWUP_ROUNDS = 5;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

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
  private llmClient: LLMClient;
  private sessionManager: SessionManager;
  private toolExecutor?: ToolExecutor;
  private onEvent?: (event: AgentEvent) => void;
  private hookRegistrations: HookRegistration[] = [];

  constructor(config: AgentRunnerConfig) {
    this.llmClient = config.llmClient;
    this.sessionManager = config.sessionManager;
    this.toolExecutor = config.toolExecutor;
    this.onEvent = config.onEvent;
  }

  on<K extends HookName>(
    hookName: K,
    handler: HookHandlerMap[K],
    options?: { priority?: number; name?: string },
  ): this {
    this.hookRegistrations.push({
      hookName,
      handler,
      priority: options?.priority ?? 0,
      name: options?.name,
    } as HookRegistration);
    return this;
  }

  private getHooks<K extends HookName>(hookName: K): Array<{ handler: HookHandlerMap[K]; name?: string }> {
    return this.hookRegistrations
      .filter((r): r is HookRegistration<K> => r.hookName === hookName)
      .sort((a, b) => b.priority - a.priority)
      .map((r) => ({ handler: r.handler as HookHandlerMap[K], name: r.name }));
  }

  // ── 公共入口 ─────────────────────────────────────────────

  async run(params: RunParams): Promise<RunResult> {
    const contextWindowTokens = params.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const compaction = params.compaction ?? DEFAULT_COMPACTION_CONFIG;

    this.emit({ type: 'run_start' });

    // 保存用户消息到 session（在所有重试前只保存一次，避免重复写入）
    await this.sessionManager.appendMessage(params.sessionKey, {
      role: 'user',
      content: params.message,
    });

    let compactionAttempts = 0;
    let compacted = false;

    // 外层压缩重试循环：捕获 ContextOverflowError，压缩 session 后重试
    while (true) {
      try {
        const result = await this.runAttempt(params, contextWindowTokens, compaction);
        const finalResult: RunResult = { ...result, compacted };
        this.emit({ type: 'run_end', result: finalResult });
        return finalResult;
      } catch (err) {
        if (err instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
          // 执行 LLM 摘要压缩，写入持久化，然后重试 runAttempt
          // runAttempt 的 loadHistory() 会重新加载压缩后的 session，自动感知摘要
          await this.compactHistory(params, compaction, err.trigger);
          compacted = true;
          compactionAttempts++;
          continue;
        }

        // 超过重试上限，或非 ContextOverflowError → 向上抛出
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit({ type: 'error', error });
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
    params: RunParams,
    contextWindowTokens: number,
    compaction: CompactionConfig,
  ): Promise<Omit<RunResult, 'compacted'>> {
    const maxToolRounds = params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const maxFollowUpRounds = params.maxFollowUpRounds ?? DEFAULT_MAX_FOLLOWUP_ROUNDS;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

    // 1. 加载历史消息（不含当前用户消息）
    //    若 session 有压缩记录，loadHistory 会自动截断并注入摘要
    let messages: ChatMessage[] = this.loadHistory(params.sessionKey);

    // 2. Layer 1: per-result 裁剪（仅操作历史消息，不触碰当前用户消息）
    if (compaction.enabled) {
      messages = pruneToolResults(messages, compaction, contextWindowTokens, (info) => {
        this.emit({
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

    // 4. delay-append：预判检查通过后才将当前用户消息 append 进 messages
    messages = [...messages, { role: 'user', content: params.message }];

    // 5. 两层循环
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalToolRounds = 0;
    let lastContent: ChatContentBlock[] = [];
    let lastStopReason = 'end_turn';
    let followUpRounds = 0;

    // 外层：处理 followUp（当前预留为空，将来实现 steering 时填充）
    outer: while (true) {
      if (followUpRounds >= maxFollowUpRounds) {
        break;
      }

      let toolRounds = 0; // 每次外层迭代重置（每轮独立额度）
      let hasMoreToolCalls = true; // 初始 true，保证至少一次 LLM 调用

      // 内层：LLM 调用 + tool use
      while (hasMoreToolCalls) {
        this.emit({ type: 'llm_call', round: totalToolRounds });

        // 流式调用 LLM（内部捕获 API 级别的 context overflow 错误）
        const llmResult = await this.callLLMStream({
          model: params.model,
          system: params.systemPrompt,
          messages,
          tools: params.tools,
          maxTokens,
        });

        totalUsage = {
          inputTokens: totalUsage.inputTokens + llmResult.usage.inputTokens,
          outputTokens: totalUsage.outputTokens + llmResult.usage.outputTokens,
        };

        lastContent = llmResult.content;
        lastStopReason = llmResult.stopReason;

        messages.push({ role: 'assistant', content: llmResult.content });

        await this.sessionManager.appendMessage(params.sessionKey, {
          role: 'assistant',
          content: llmResult.content,
        });

        // error / aborted → 提前返回（与 pi-agent-core 一致）
        if (lastStopReason === 'error' || lastStopReason === 'aborted') {
          const text = this.extractText(lastContent);
          return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
        }

        const toolUseBlocks = llmResult.content.filter(
          (b): b is Extract<ChatContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0) {
          // 没有 tool calls → 退出内层循环
          hasMoreToolCalls = false;
        } else {
          // 安全检查：toolRounds >= maxToolRounds → 不执行工具，退出内层
          if (toolRounds >= maxToolRounds) {
            hasMoreToolCalls = false;
            break;
          }

          // 执行工具
          const toolResultBlocks: ChatContentBlock[] = [];
          for (const toolUse of toolUseBlocks) {
            // tool_use 事件发原始 input（hook 运行之前）
            this.emit({ type: 'tool_use', name: toolUse.name, input: toolUse.input });

            // before_tool_call hooks（sequential，priority 降序）
            let effectiveInput = toolUse.input;
            const beforeHooks = this.getHooks('before_tool_call');
            if (beforeHooks.length > 0) {
              const beforeResult = await runBeforeToolCall(beforeHooks, {
                toolName: toolUse.name,
                input: toolUse.input,
              });
              if (beforeResult.action === 'deny') {
                const blocked: ToolResult = { content: `Tool blocked: ${beforeResult.reason}`, isError: true };
                this.emit({ type: 'tool_result', name: toolUse.name, result: blocked });
                toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: blocked.content });
                continue;
              }
              effectiveInput = beforeResult.input;
            }

            // 执行工具
            const startTime = Date.now();
            const result = await this.executeTool(toolUse.name, effectiveInput);
            const durationMs = Date.now() - startTime;

            this.emit({ type: 'tool_result', name: toolUse.name, result });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result.content,
            });

            // after_tool_call hooks（fire-and-forget，使用修改后的 input）
            const afterHooks = this.getHooks('after_tool_call');
            if (afterHooks.length > 0) {
              runAfterToolCall(afterHooks, {
                toolName: toolUse.name,
                input: effectiveInput,
                result,
                durationMs,
              });
            }
          }

          // toolResult push 到 messages（Anthropic API 格式：role=user）
          messages.push({ role: 'user', content: toolResultBlocks });

          await this.sessionManager.appendMessage(params.sessionKey, {
            role: 'toolResult',
            content: toolResultBlocks,
          });

          // 内层 Layer 1: 新 tool result 追加后做 per-result 裁剪
          if (compaction.enabled) {
            messages = pruneToolResults(messages, compaction, contextWindowTokens);
          }

          // 内层 90% 阈值检查：主动检测，避免等待 LLM API 报错
          if (compaction.enabled) {
            const estimated = estimatePromptTokens({ messages, systemPrompt: params.systemPrompt });
            if (estimated > contextWindowTokens * INNER_LOOP_OVERFLOW_THRESHOLD) {
              throw new ContextOverflowError(
                `Context exceeds ${INNER_LOOP_OVERFLOW_THRESHOLD * 100}% threshold during tool loop `
                + `(estimated ${estimated} of ${contextWindowTokens} tokens)`,
              );
            }
          }

          toolRounds++;
          totalToolRounds++;
        }
      }
      // 内层退出

      // 检查 followUp 消息（当前预留，返回空）
      const followUpMessages = this.getFollowUpMessages();
      if (followUpMessages.length > 0) {
        followUpRounds++;
        continue outer;
      }

      break;
    }

    const text = this.extractText(lastContent);
    return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
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
    params: RunParams,
    compaction: CompactionConfig,
    trigger: 'preemptive' | 'overflow' | 'manual',
  ): Promise<void> {
    // 加载当前历史消息（用于压缩，不含当前用户消息）
    const messages = this.loadHistory(params.sessionKey);
    const tokensBefore = estimatePromptTokens({ messages });

    this.emit({ type: 'compaction_start', trigger, tokensBefore });

    // 执行 LLM 摘要压缩
    const compactResult = await compactMessages({
      messages,
      config: compaction,
      llmClient: this.llmClient,
      model: params.model,
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

    this.emit({
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

    // 转换为 ChatMessage 格式
    const messages: ChatMessage[] = effectiveRecords.map((record: MessageRecord) => {
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
   * 额外处理：捕获 LLM API 返回的 context overflow 类型错误，
   * 包装成 ContextOverflowError 向上抛出，使外层 retry 循环能统一处理。
   */
  private async callLLMStream(params: {
    model: string;
    system?: string;
    messages: ChatMessage[];
    tools?: RunParams['tools'];
    maxTokens: number;
  }): Promise<{ content: ChatContentBlock[]; stopReason: string; usage: TokenUsage }> {
    const contentBlocks: ChatContentBlock[] = [];
    let currentText = '';
    let stopReason = 'end_turn';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const event of this.llmClient.chatStream({
        model: params.model,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        maxTokens: params.maxTokens,
      })) {
        switch (event.type) {
          case 'text_delta':
            currentText += event.text;
            this.emit({ type: 'text_delta', text: event.text });
            break;

          case 'tool_use':
            if (currentText) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            contentBlocks.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
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
      // 将 LLM API 的 context overflow 错误统一包装为 ContextOverflowError
      if (err instanceof Error && isContextOverflowError(err)) {
        throw new ContextOverflowError(`LLM API context overflow: ${err.message}`);
      }
      throw err;
    }

    if (currentText) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    return { content: contentBlocks, stopReason, usage };
  }

  /**
   * 执行工具。如果没有 toolExecutor，返回错误消息。
   */
  private async executeTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!this.toolExecutor) {
      return {
        content: `Error: No tool executor configured. Cannot execute tool "${toolName}".`,
        isError: true,
      };
    }

    try {
      return await this.toolExecutor(toolName, input);
    } catch (err) {
      return {
        content: `Error executing tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  /** 从 content blocks 中提取纯文本 */
  private extractText(content: ChatContentBlock[]): string {
    return content
      .filter((b): b is Extract<ChatContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  /**
   * 获取 followUp 消息。当前预留为空，将来实现 steering/followUp 时填充。
   */
  private getFollowUpMessages(): ChatMessage[] {
    return [];
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }
}
