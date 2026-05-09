import * as readline from 'node:readline';
import type { AgentEvent } from '../../core/runner/types.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelApprovalAdapter,
  ChannelRunRequest,
} from './types.js';

const MAX_TOOL_RESULT_PREVIEW = 200;

// ── ANSI helpers ────────────────────────────────────────────────────
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export interface CliChannelConfig {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: string;
  /** 单 channel 单 session：所有 CLI 输入归到此 sessionKey。默认 'main' */
  sessionKey?: string;
  /** 启用审批交互；启用时收到审批请求会阻塞 readline 等待 y/n */
  approval?: boolean;
}

export class CliChannel implements Channel {
  readonly id = 'cli';
  readonly approval?: ChannelApprovalAdapter;

  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly promptText: string;
  private readonly sessionKey: string;
  private rl?: readline.Interface;

  private messageHandler?: (req: ChannelRunRequest) => Promise<void>;
  private approvalDecisionHandler?: (id: string, decision: ApprovalDecision) => void;

  /** 流式输出过程中插入 tool/error 行前需要先换行；run_end / 显式插入会重置 */
  private inStream = false;
  private stopped = false;
  /** 当前 readline.question 的 reject，用于 stop() 时唤醒阻塞的 prompt */
  private pendingPromptReject?: (err: Error) => void;
  /** 已超时但仍可能等到用户输入的 approval id，用户回答时直接吞掉不再回填 */
  private expiredApprovalIds = new Set<string>();

  constructor(config: CliChannelConfig = {}) {
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
    this.promptText = config.prompt ?? '> ';
    this.sessionKey = config.sessionKey ?? 'main';

    if (config.approval) {
      this.approval = this.makeApprovalAdapter();
    }
  }

  // ── Channel.send 实现 ───────────────────────────────────────────────

  send(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.inStream = true;
        this.output.write(event.text);
        break;

      case 'tool_use':
        this.breakStream();
        this.output.write(dim(`[tool: ${event.name}]\n`));
        break;

      case 'tool_result': {
        const preview = event.result.content.length > MAX_TOOL_RESULT_PREVIEW
          ? event.result.content.slice(0, MAX_TOOL_RESULT_PREVIEW) + '…'
          : event.result.content;
        const label = event.result.isError ? red('[tool error]') : dim('[tool result]');
        this.output.write(`${label} ${dim(preview)}\n`);
        break;
      }

      case 'compaction_start':
        this.breakStream();
        this.output.write(yellow(`[compacting… trigger=${event.trigger}]\n`));
        break;

      case 'compaction_end':
        this.output.write(
          yellow(
            `[compacted: ${event.tokensBefore} → ${event.tokensAfter} tokens, dropped ${event.droppedMessages} messages]\n`,
          ),
        );
        break;

      case 'error':
        // 不在 send 输出 error：runner 触发 error event 后会立刻 throw，
        // 由 start() 的 try/catch 统一以 [error] 输出，避免双行重复。
        // 其他 channel（如 WebSocketChannel）可能选择推送 error event 给 client。
        this.breakStream();
        break;

      case 'run_end':
        this.breakStream();
        break;

      // run_start / llm_call / tool_result_pruned 默认忽略
    }
  }

  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // ── 生命周期 ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.messageHandler) {
      throw new Error('CliChannel.start: no message handler registered (call registerChannel first)');
    }

    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: true,
    });

    // readline 关闭时也视作 stop
    this.rl.on('close', () => {
      this.stopped = true;
    });

    while (!this.stopped) {
      let line: string;
      try {
        line = await this.question(this.promptText);
      } catch {
        // rl.close() 引发 question reject → 退出循环
        break;
      }

      if (this.stopped) break;

      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        await this.messageHandler({
          sessionKey: this.sessionKey,
          message: trimmed,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.breakStream();
        this.output.write(red(`[error] ${message}\n`));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingPromptReject?.(new Error('CliChannel stopped'));
    this.rl?.close();
    this.rl = undefined;
  }

  // ── 内部辅助 ───────────────────────────────────────────────────────

  private breakStream(): void {
    if (this.inStream) {
      this.output.write('\n');
      this.inStream = false;
    }
  }

  private question(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.rl) {
        reject(new Error('readline not initialized'));
        return;
      }
      this.pendingPromptReject = reject;
      this.rl.question(prompt, (answer) => {
        this.pendingPromptReject = undefined;
        resolve(answer);
      });
    });
  }

  private makeApprovalAdapter(): ChannelApprovalAdapter {
    return {
      sendApprovalRequest: (request: ApprovalRequest) => {
        this.breakStream();
        this.output.write(
          yellow(
            `[approval] tool: ${request.toolName}\n           input: ${JSON.stringify(request.input)}\n`,
          ),
        );
        // 在 messageHandler 阻塞期间另起一个 question 读 y/n。
        // readline 的主 prompt 此时已 resolved，未在 listen，可安全复用。
        this.question(yellow('approve? (y/n)> ')).then(
          (answer) => {
            if (this.expiredApprovalIds.delete(request.id)) {
              // 用户回答晚于超时，吞掉不再回填
              return;
            }
            const decision: ApprovalDecision =
              answer.trim().toLowerCase() === 'y' ? 'allow' : 'deny';
            this.approvalDecisionHandler?.(request.id, decision);
          },
          () => {
            // stop() 引发 reject，忽略
          },
        );
      },
      sendApprovalExpired: (request: ApprovalRequest) => {
        this.expiredApprovalIds.add(request.id);
        this.output.write(yellow(`\n[approval] timed out (denied)\n`));
      },
      onApprovalDecision: (handler) => {
        this.approvalDecisionHandler = handler;
      },
    };
  }
}
