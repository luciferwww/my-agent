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

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOOL_ROUNDS = 10;
const DEFAULT_MAX_FOLLOWUP_ROUNDS = 5;

/**
 * Agent 执行引擎，串联所有模块完成一次完整的对话循环。
 *
 * 两层循环结构（对齐 pi-agent-core 的 runLoop）：
 * - 外层：处理 followUp 消息（当前预留为空）
 * - 内层：LLM 调用 + tool use 循环
 *
 * 参考 OpenClaw 的 runEmbeddedAttempt()（src/agents/pi-embedded-runner/run/attempt.ts）
 * 和 pi-agent-core 的 runLoop()（agent-loop.js）。
 */
export class AgentRunner {
  private llmClient: LLMClient;
  private sessionManager: SessionManager;
  private toolExecutor?: ToolExecutor;
  private onEvent?: (event: AgentEvent) => void;

  constructor(config: AgentRunnerConfig) {
    this.llmClient = config.llmClient;
    this.sessionManager = config.sessionManager;
    this.toolExecutor = config.toolExecutor;
    this.onEvent = config.onEvent;
  }

  async run(params: RunParams): Promise<RunResult> {
    const maxToolRounds = params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const maxFollowUpRounds = params.maxFollowUpRounds ?? DEFAULT_MAX_FOLLOWUP_ROUNDS;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.emit({ type: 'run_start' });

    try {
      // 1. 从 session 加载历史消息，转换为 ChatMessage[]
      const history = this.loadHistory(params.sessionKey);

      // 2. 保存用户消息到 session
      await this.sessionManager.appendMessage(params.sessionKey, {
        role: 'user',
        content: params.message,
      });

      // 3. 构建可变 messages 数组（后续直接 push，与 pi-agent-core 一致）
      const messages: ChatMessage[] = [
        ...history,
        { role: 'user', content: params.message },
      ];

      // 4. 两层循环
      let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let totalToolRounds = 0;
      let lastContent: ChatContentBlock[] = [];
      let lastStopReason = 'end_turn';
      let followUpRounds = 0;

      // 外层循环：处理 followUp（当前预留为空）
      outer: while (true) {
        if (followUpRounds >= maxFollowUpRounds) {
          break;
        }

        let toolRounds = 0; // 每次外层迭代重置（每轮独立额度）
        let hasMoreToolCalls = true; // 初始 true，保证至少一次 LLM 调用

        // 内层循环：LLM 调用 + tool use
        while (hasMoreToolCalls) {
          this.emit({ type: 'llm_call', round: totalToolRounds });

          // 流式调用 LLM
          const llmResult = await this.callLLMStream({
            model: params.model,
            system: params.systemPrompt,
            messages,
            tools: params.tools,
            maxTokens,
          });

          // 累计 usage
          totalUsage = {
            inputTokens: totalUsage.inputTokens + llmResult.usage.inputTokens,
            outputTokens: totalUsage.outputTokens + llmResult.usage.outputTokens,
          };

          lastContent = llmResult.content;
          lastStopReason = llmResult.stopReason;

          // assistant 消息 push 到 messages
          messages.push({ role: 'assistant', content: llmResult.content });

          // 保存 assistant 消息到 session
          await this.sessionManager.appendMessage(params.sessionKey, {
            role: 'assistant',
            content: llmResult.content,
          });

          // error / aborted → return 退出整个函数（与 pi-agent-core 一致）
          if (lastStopReason === 'error' || lastStopReason === 'aborted') {
            const text = this.extractText(lastContent);
            const result: RunResult = {
              text,
              content: lastContent,
              stopReason: lastStopReason,
              usage: totalUsage,
              toolRounds: totalToolRounds,
            };
            this.emit({ type: 'run_end', result });
            return result;
          }

          // 检查 content 中有没有 tool_use blocks
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
              this.emit({ type: 'tool_use', name: toolUse.name, input: toolUse.input });

              const result = await this.executeTool(toolUse.name, toolUse.input);

              this.emit({ type: 'tool_result', name: toolUse.name, result });

              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: result.content,
              });
            }

            // toolResult push 到 messages（Anthropic API 格式：role=user）
            messages.push({ role: 'user', content: toolResultBlocks });

            // 保存 toolResult 到 session（独立 role，与 pi-ai 一致）
            await this.sessionManager.appendMessage(params.sessionKey, {
              role: 'toolResult',
              content: toolResultBlocks,
            });

            toolRounds++;
            totalToolRounds++;
          }
        }
        // 内层退出

        // 检查 followUp 消息（当前预留，返回空）
        const followUpMessages = this.getFollowUpMessages();
        if (followUpMessages.length > 0) {
          // 将来实现：注入 followUp 消息到 messages
          followUpRounds++;
          continue outer;
        }

        // 无 followUp → 退出外层
        break;
      }

      // 5. 构建结果
      const text = this.extractText(lastContent);
      const result: RunResult = {
        text,
        content: lastContent,
        stopReason: lastStopReason,
        usage: totalUsage,
        toolRounds: totalToolRounds,
      };

      this.emit({ type: 'run_end', result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit({ type: 'error', error });
      throw error;
    }
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 从 session 加载历史消息，转换为 llm-client 的 ChatMessage 格式。
   * toolResult role 转换为 user role（对��� Anthropic API）。
   */
  private loadHistory(sessionKey: string): ChatMessage[] {
    const records = this.sessionManager.getMessages(sessionKey);
    return records.map((record: MessageRecord) => {
      if (record.message.role === 'toolResult') {
        return {
          role: 'user' as const,
          content: record.message.content,
        };
      }
      return {
        role: record.message.role as 'user' | 'assistant',
        content: record.message.content,
      };
    });
  }

  /**
   * 流式调用 LLM，一边触发 onEvent 一边收集结果。
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

  /**
   * 从 content blocks 中提取纯文本。
   */
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
