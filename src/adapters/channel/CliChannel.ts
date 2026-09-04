import * as readline from 'node:readline';
import type { AgentEvent } from '../../core/runner/types.js';
import { Logger } from '../../platform/logger/index.js';
import type {
  AbortHookBindings,
  ApprovalClosedResult,
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelApprovalAdapter,
  ChannelInteractionAdapter,
  ChannelRunRequest,
  TurnInteractionResponse,
} from './types.js';

// Tool result preview budget: head + tail lines visible, middle elided.
// 10:6 split leans toward head because most CLI output (lists, file content,
// command echo) puts context up front; tail mainly catches errors / summaries.
const PREVIEW_HEAD_LINES = 10;
const PREVIEW_TAIL_LINES = 6;
// Per-line cap so a single very long line can't blow up the preview format.
const PREVIEW_LINE_MAX_CHARS = 200;
const MAX_TOOL_RESULT_PREVIEW = 200;

/**
 * Ctrl+C 双击退出窗口。在此区间内连按两次 → process.exit(130)；超时
 * 则重置为单击。与 openclaw 对齐（core-abort-spec.md §12 D1）。
 */
const CTRL_C_EXIT_WINDOW_MS = 1000;

const log = Logger.get('CliChannel');

// ── ANSI helpers ────────────────────────────────────────────────────
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function truncateLine(line: string): string {
  return line.length > PREVIEW_LINE_MAX_CHARS
    ? line.slice(0, PREVIEW_LINE_MAX_CHARS) + '…'
    : line;
}

// Collapse consecutive blank lines (incl. whitespace-only) to one.
// Keeps paragraph separators but prevents long runs of blanks from eating
// the head/tail budget. Non-empty lines are pushed verbatim — leading
// indentation is preserved.
function collapseEmptyLines(lines: string[]): string[] {
  const result: string[] = [];
  let prevEmpty = false;
  for (const line of lines) {
    const isEmpty = line.trim() === '';
    if (isEmpty && prevEmpty) continue;
    result.push(line);
    prevEmpty = isEmpty;
  }
  return result;
}

// Returns the lines to render for a tool result (display only — full content
// still goes to the LLM via the tool executor).
//   1. drop trailing blank lines
//   2. collapse consecutive blanks
//   3. if total ≤ HEAD+TAIL, show all; else head + omission marker + tail
function formatToolResultPreview(content: string): string[] {
  const trimmed = content.replace(/\n+$/, '');
  if (!trimmed) return [];
  const lines = collapseEmptyLines(trimmed.split('\n'));
  if (lines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES) {
    return lines.map(truncateLine);
  }
  const head = lines.slice(0, PREVIEW_HEAD_LINES).map(truncateLine);
  const tail = lines.slice(-PREVIEW_TAIL_LINES).map(truncateLine);
  const omitted = lines.length - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES;
  return [...head, `... [${omitted} lines omitted]`, ...tail];
}

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
  readonly interaction?: ChannelInteractionAdapter;
  readonly approval?: ChannelApprovalAdapter;

  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly promptText: string;
  private readonly sessionKey: string;
  private rl?: readline.Interface;

  private messageHandler?: (req: ChannelRunRequest) => Promise<void>;
  private approvalDecisionHandler?: (id: string, decision: ApprovalDecision) => void;
  private interactionResponseHandler?: (response: TurnInteractionResponse) => void;

  /** 流式输出过程中插入 tool/error 行前需要先换行；run_end / 显式插入会重置 */
  private inStream = false;
  private stopped = false;
  /** 当前 readline.question 的 AbortController，用于 closure/stop 时取消底层读操作 */
  private pendingPromptAbort?: AbortController;
  // ── Abort / Ctrl+C 状态（core-abort-spec.md §12）─────────────
  /** 上次 Ctrl+C 时间戳（epoch ms）；0 = 没有近期按键。用于双击检测。 */
  private lastCtrlCAt = 0;
  /** RuntimeApp 通过 `bindAbortHooks` 注入的回调；未注册 channel 时为 undefined。 */
  private abortHooks?: AbortHookBindings;
  /**
   * SIGINT handler 存为 bound instance field，`stop()` 时用同一引用
   * `process.off(...)` 才能干净解绑。若每次现场用 arrow 装配则无法解绑，
   * 反复 start/stop 会导致 handler 堆积。
   */
  private readonly boundSigIntHandler = () => this.handleSigInt();

  constructor(config: CliChannelConfig = {}) {
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
    this.promptText = config.prompt ?? '> ';
    this.sessionKey = config.sessionKey ?? 'main';

    if (config.approval) {
      this.interaction = this.makeInteractionAdapter();
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

      case 'user_message': {
        // originClientId === null 表示来自 CLI / library 入口 —— CLI 用户自己刚敲下过，
        // 无需回显；仅在外部客户端触发时在终端渲染。
        // 已知 limitation G1：library 注入也走 null 分支，见 spec §5.4。
        if (event.originClientId === null) break;
        this.breakStream();
        const count = event.attachmentSummaries?.length ?? 0;
        const attachHint = count
          ? dim(` (+${count} attachment${count > 1 ? 's' : ''})`)
          : '';
        const who = ` @${event.originClientId.slice(0, 6)}`;
        this.output.write(cyan(`[user${who}]`) + ` ${event.content}${attachHint}\n`);
        break;
      }

      case 'tool_use':
        this.breakStream();
        this.output.write(dim(`[tool: ${event.name}]\n`));
        break;

      case 'tool_result': {
        const label = event.result.isError ? red('[tool error]') : dim('[tool result]');
        const previewLines = formatToolResultPreview(event.result.content);
        if (previewLines.length === 0) {
          this.output.write(`${label}\n`);
        } else if (previewLines.length === 1) {
          this.output.write(`${label} ${dim(previewLines[0])}\n`);
        } else {
          this.output.write(`${label}\n`);
          for (const line of previewLines) {
            this.output.write(dim(`  ${line}`) + '\n');
          }
        }
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

      case 'subagent_start':
        // Open a visual nesting level for the subagent. We don't track
        // indentation state here; the depth tag is enough for a CLI.
        this.breakStream();
        this.output.write(
          cyan(`[▶ subagent: ${event.subagentType} (depth=${event.depth})]\n`),
        );
        break;

      case 'subagent_end': {
        this.breakStream();
        const colorize = event.outcome === 'ok' ? cyan : red;
        const failureSuffix = event.failure ? ` reason="${event.failure.message}"` : '';
        this.output.write(
          colorize(
            `[◀ subagent: ${event.subagentType} outcome=${event.outcome} ${event.durationMs}ms${failureSuffix}]\n`,
          ),
        );
        break;
      }

      // run_start / llm_call / tool_result_pruned 默认忽略
    }
  }

  onMessage(handler: (req: ChannelRunRequest) => Promise<void>): void {
    this.messageHandler = handler;
    log.debug('message handler registered', {
      channelId: this.id,
      sessionKey: this.sessionKey,
    });
  }

  // ── 生命周期 ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.messageHandler) {
      throw new Error('CliChannel.start: no message handler registered (call registerChannel first)');
    }

    this.stopped = false;

    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: true,
    });

    // readline 关闭时也视作 stop
    this.rl.on('close', () => {
      this.stopped = true;
      log.info('cli channel readline closed', {
        channelId: this.id,
        sessionKey: this.sessionKey,
      });
    });

    // 【关键】给 rl 实例挂 SIGINT listener 才能拦截 readline 的 default 行为
    // （空 prompt 收到 ^C 会 emit 'SIGINT' + rl.close()）。挂了 listener 后
    // readline 只 emit 'SIGINT' 而不再 close，控制权交给 handleSigInt。
    // 未挂时 readline 会调 `process.kill(process.pid, 'SIGINT')` 让 process-
    // level handler 兜底——但空 prompt 那条路径同时会关掉 rl，等价于直接退出。
    this.rl.on('SIGINT', () => this.handleSigInt());

    // 接管进程级 SIGINT，覆盖外部 kill signal（`kill -INT pid`）等
    // readline 触不到的场景。需先 removeAllListeners('SIGINT') 清除
    // readline.Interface 构造时可能装的默认 process-level listener。
    //
    // 【假设：CliChannel 独占进程 SIGINT】`removeAllListeners('SIGINT')`
    // 是刻意的粗暴：它会连带清除宿主进程中其他库（测试框架、外层 embed
    // 场景的 host 等）注册的 listener。此假设对应 CliChannel 的典型用例：
    // interactive CLI 独占前台进程。若未来出现 "CliChannel 被嵌入其他进程"
    // 的场景，需重新设计——候选方案：
    //   (a) 先 snapshot 现有 listener、在 CliChannel.stop() 里恢复；
    //   (b) 不清除，只叠加自己的 handler，依赖 Node 会调用所有 listener
    //       的行为——但 readline 默认 listener 的 close 逻辑会干扰双击
    //       退出 UX，需要额外协调；
    //   (c) 通过构造参数让 caller 显式选择接管策略。
    // 详见 core-abort-spec.md §12。
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', this.boundSigIntHandler);

    log.info('cli channel started', {
      channelId: this.id,
      sessionKey: this.sessionKey,
      approvalEnabled: !!this.interaction,
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

      log.info('cli input received', {
        channelId: this.id,
        sessionKey: this.sessionKey,
        length: trimmed.length,
      });

      try {
        await this.messageHandler({
          sessionKey: this.sessionKey,
          message: trimmed,
        });
        log.debug('cli input dispatched', {
          channelId: this.id,
          sessionKey: this.sessionKey,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.breakStream();
        this.output.write(red(`[error] ${message}\n`));
        log.error('cli message handling failed', {
          channelId: this.id,
          sessionKey: this.sessionKey,
          error: message,
        });
      }
    }

    log.info('cli channel stopped', {
      channelId: this.id,
      sessionKey: this.sessionKey,
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    log.info('cli channel stopping', {
      channelId: this.id,
      sessionKey: this.sessionKey,
    });
    // 卸载自己装的 SIGINT handler，避免：
    //  (a) 宿主进程后续不再希望 CliChannel 拦截 Ctrl+C 时 handler 泄漏
    //  (b) 将来 restart（同一进程内 stop() → start()）双绑
    // 不负责恢复 start() 时被 `removeAllListeners('SIGINT')` 清掉的其他 listener
    // ——与上述 “CliChannel 独占进程 SIGINT” 假设同源。
    process.off('SIGINT', this.boundSigIntHandler);
    this.pendingPromptAbort?.abort(new Error('CliChannel stopped'));
    this.rl?.close();
    this.rl = undefined;
  }

  // ── Abort / Ctrl+C 处理（core-abort-spec.md §12）────────────────

  bindAbortHooks(hooks: AbortHookBindings): void {
    this.abortHooks = hooks;
    log.debug('abort hooks bound', { channelId: this.id });
  }

  /**
   * SIGINT 处理主干。精确语义见 core-abort-spec.md §12：
   *
   *  1. 若上一次在窗口内→ process.exit(130)（约定俗成 signal-based exit code）。
   *  2. 更新 lastCtrlCAt（为双击窗口计时）。
   *  3. 查 `querySessionsNeedingAbort()`：
   *     - 空（无 active turn + 无 queue）→ 仅提示 "press again to exit"，不调 abort。
   *     - 非空→ 对每个 sessionKey 调 `abortHooks.abortTurn(sk)`，依返回值中
   *       `aborted` / `dropped` 非零部分拼提示（可能只有其中一部分）。
   *
   * `abortHooks` 未 bind 时直接当作 “无东西可 abort” 处理（退到提示分支），
   * 支持 CliChannel 单独跑（不接 RuntimeApp）下 Ctrl+C 仍能双击退出。
   */
  private handleSigInt(): void {
    const now = Date.now();
    const sinceLast = now - this.lastCtrlCAt;

    // 双击：窗口内连按两次 → exit
    if (this.lastCtrlCAt > 0 && sinceLast <= CTRL_C_EXIT_WINDOW_MS) {
      this.breakStream();
      this.output.write(red('[exiting]\n'));
      log.info('cli exiting on double Ctrl+C', { channelId: this.id });
      process.exit(130);
    }

    this.lastCtrlCAt = now;

    // 【与 D3 语义一致】判断 “是否有东西可 abort” 时必须同时考虑：
    //  (i) 有 active turn（→ 会被 abort）
    //  (ii) 有 queued messages（→ 会被 drop）
    // 仅两者都为空时才提示 "press again to exit"；否则统一走 abortTurn 路径。
    // 详见 core-abort-spec.md §12。
    const targets = this.abortHooks?.querySessionsNeedingAbort() ?? [];
    if (targets.length === 0) {
      this.breakStream();
      this.output.write(dim('[press Ctrl+C again within 1s to exit]\n'));
      return;
    }

    // 有 active turn 或 queued messages → 对所有目标 abort；abortTurn 返回
    // { aborted, dropped }，一次拿到全部信息后本地直接渲染，不依赖 event。
    let totalAborted = 0;
    let totalDropped = 0;
    for (const sk of targets) {
      const r = this.abortHooks!.abortTurn(sk);
      if (r.aborted) totalAborted += 1;
      totalDropped += r.dropped;
    }

    // 渲染：totalAborted / totalDropped 可能各自为 0——只拼非零部分。
    const parts: string[] = [];
    if (totalAborted > 0) parts.push(`aborted ${totalAborted} turn(s)`);
    if (totalDropped > 0) parts.push(`dropped ${totalDropped} queued message(s)`);
    this.breakStream();
    this.output.write(yellow(`[⚠ ${parts.join('; ')}]\n`));
    log.info('cli abort triggered by Ctrl+C', {
      channelId: this.id,
      sessions: targets.length,
      totalAborted,
      totalDropped,
    });
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
      const controller = new AbortController();
      const clear = () => {
        if (this.pendingPromptAbort === controller) {
          this.pendingPromptAbort = undefined;
        }
        controller.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        clear();
        reject(controller.signal.reason);
      };
      this.pendingPromptAbort = controller;
      controller.signal.addEventListener('abort', onAbort, { once: true });
      this.rl.question(prompt, { signal: controller.signal }, (answer) => {
        clear();
        resolve(answer);
      });
    });
  }

  private makeApprovalAdapter(): ChannelApprovalAdapter {
    return {
      sendApprovalRequest: (request: ApprovalRequest) => {
        log.info('approval request received for cli', {
          channelId: this.id,
          approvalId: request.id,
          toolName: request.toolName,
          sessionKey: request.sessionKey,
          turnId: request.turnId,
        });
        return this.promptApproval(request, (decision) => {
          this.dispatchApprovalSubmission(request.id, decision);
        });
      },
      sendApprovalClosed: (request: ApprovalRequest, result: ApprovalClosedResult) => {
        this.closeApproval(request.id, result);
      },
      onApprovalDecision: (handler) => {
        this.approvalDecisionHandler = handler;
      },
      onApprovalUnavailable: () => {
        // CLI approval origin shares the channel process lifecycle.
      },
    };
  }

  private makeInteractionAdapter(): ChannelInteractionAdapter {
    return {
      sendInteractionRequest: (request) => {
        if (request.kind !== 'approval') {
          throw new Error(`CliChannel does not support interaction kind: ${request.kind}`);
        }
        return this.promptApproval(request, (decision) => {
          this.dispatchApprovalSubmission(request.id, decision);
        });
      },
      sendInteractionClosed: (request, result) => {
        if (request.kind !== 'approval') {
          throw new Error(`CliChannel does not support interaction kind: ${request.kind}`);
        }
        this.closeApproval(request.id, result);
      },
      onInteractionResponse: (handler) => {
        this.interactionResponseHandler = handler;
      },
      onInteractionUnavailable: () => {
        // CLI approval origin shares the channel process lifecycle.
      },
    };
  }

  private dispatchApprovalSubmission(id: string, decision: ApprovalDecision): void {
    log.info('approval submitted from cli', {
      channelId: this.id,
      approvalId: id,
      decision,
      routedAs: this.interactionResponseHandler ? 'interaction' : 'approval',
    });

    if (this.interactionResponseHandler) {
      this.interactionResponseHandler({
        id,
        kind: 'approval',
        outcome: 'submitted',
        decision,
      });
      return;
    }

    this.approvalDecisionHandler?.(id, decision);
  }

  private promptApproval(
    request: Pick<ApprovalRequest, 'id' | 'toolName' | 'input'>,
    onDecision: (decision: ApprovalDecision) => void,
  ): { status: 'accepted' } | { status: 'unavailable'; reason: 'delivery_failed' } {
    if (!this.rl) {
      return { status: 'unavailable', reason: 'delivery_failed' };
    }
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
        const decision: ApprovalDecision =
          answer.trim().toLowerCase() === 'y' ? 'allow' : 'deny';
        log.debug('cli approval answer captured', {
          channelId: this.id,
          approvalId: request.id,
          decision,
        });
        onDecision(decision);
      },
      () => {
        // stop() 引发 reject，忽略
        log.debug('cli approval prompt aborted', {
          channelId: this.id,
          approvalId: request.id,
        });
      },
    );
    return { status: 'accepted' };
  }

  private closeApproval(id: string, result: ApprovalClosedResult): void {
    this.pendingPromptAbort?.abort(new Error('Approval closed'));
    this.output.write(yellow(`\n[approval] closed (${result.outcome})\n`));
    log.info('cli approval closed', {
      channelId: this.id,
      approvalId: id,
      outcome: result.outcome,
    });
  }
}
