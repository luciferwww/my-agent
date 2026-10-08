import * as readline from 'node:readline';
import type { AgentEvent } from '../../../core/runner/types.js';
import { Logger } from '../../../platform/logger/index.js';
import type {
  ApprovalClosedResult,
  ApprovalDecision,
  ApprovalRequest,
  Channel,
  ChannelCompletion,
  ChannelInteractionAdapter,
  ChannelRunRequest,
  ChannelRuntimeCapabilities,
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  SessionCapability,
  SessionHistoryMessage,
  SessionHistoryPage,
  TurnInteractionResponse,
} from '../../../core/channel/index.js';
import {
  normalizeReasoningPreference,
  ReasoningPreferenceValidationError,
  type ReasoningPreference,
  type ThinkingEffort,
  type ThinkingSwitch,
} from '../../../core/model-invocation/index.js';
import type { ModelReference } from '../../../core/model-resolution/index.js';

// Tool result preview budget: head + tail lines visible, middle elided.
// 10:6 split leans toward head because most CLI output (lists, file content,
// command echo) puts context up front; tail mainly catches errors / summaries.
const PREVIEW_HEAD_LINES = 10;
const PREVIEW_TAIL_LINES = 6;
// Per-line cap so a single very long line can't blow up the preview format.
const PREVIEW_LINE_MAX_CHARS = 200;
const SESSION_HISTORY_LIMIT = 20;
const SESSION_HISTORY_MAX_LINES = 80;
const SESSION_HISTORY_MAX_CHARS = 16_384;
const PROMPT_PREEMPTED_BY_APPROVAL = Symbol('prompt-preempted-by-approval');
const THINKING_SELECTIONS = ['default', 'on', 'off'] as const;
const EFFORT_SELECTIONS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ThinkingEffort[];

type ThinkingSelection = 'default' | ThinkingSwitch;

interface CliSelectionOption<T> {
  readonly value: T;
  readonly label: string;
  readonly current?: boolean;
}

type CliSelectionResult<T> =
  | { readonly selected: true; readonly value: T }
  | { readonly selected: false };

/**
 * Ctrl+C 双击关闭窗口。进程级 force policy 由 Host 独占。
 */
const CTRL_C_EXIT_WINDOW_MS = 1_000;
const log = Logger.get('CliChannel');

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function formatReference(reference: ModelReference): string {
  return `${reference.providerId}/${formatModelId(reference.modelId)}`;
}

function formatModelId(modelId: string): string {
  if (/^[\x21-\x7e]{1,200}$/u.test(modelId)) return modelId;
  const preview = modelId.length > 200 ? `${modelId.slice(0, 200)}…` : modelId;
  return JSON.stringify(preview);
}

function formatTerminalText(value: string): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return escaped.length > 200 ? `${escaped.slice(0, 200)}…` : escaped;
}

function sameReference(
  left: ModelReference,
  right: ModelReference | undefined,
): boolean {
  return right !== undefined
    && left.providerId === right.providerId
    && left.modelId === right.modelId;
}

function hasCatalogModel(
  snapshot: ModelCatalogSnapshot,
  reference: ModelReference,
): boolean {
  return findCatalogModel(snapshot, reference) !== undefined;
}

function findCatalogModel(
  snapshot: ModelCatalogSnapshot,
  reference: ModelReference,
): ModelCatalogEntry | undefined {
  const provider = snapshot.providers.find(
    (candidate) => candidate.providerId === reference.providerId,
  );
  return provider?.models.find((model) => model.modelId === reference.modelId);
}

function getEffectiveModelReference(
  snapshot: ModelCatalogSnapshot,
  override: ModelReference | undefined,
): ModelReference | undefined {
  return override
    ?? (snapshot.defaultSelection.state === 'available'
      ? snapshot.defaultSelection.reference
      : undefined);
}

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

function formatHistoryText(label: string, content: string, compact: boolean): string[] {
  const lines = compact
    ? formatToolResultPreview(content)
    : collapseEmptyLines(content.replace(/\n+$/, '').split('\n')).map(truncateLine);
  if (lines.length === 0) return [truncateLine(label)];
  return lines.map((line, index) =>
    truncateLine(index === 0 ? `${label} ${line}` : `  ${line}`));
}

function formatHistoryMessage(message: SessionHistoryMessage): string[] {
  const roleLabel = message.role === 'user'
    ? '[you]'
    : message.role === 'assistant'
      ? '[assistant]'
      : '[tool result]';
  if (typeof message.content === 'string') {
    return formatHistoryText(roleLabel, message.content, message.role === 'toolResult');
  }

  const lines: string[] = [];
  let labeledText = false;
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        lines.push(...formatHistoryText(labeledText ? '[text]' : roleLabel, block.text, false));
        labeledText = true;
        break;
      case 'thinking':
        lines.push(...formatHistoryText(`[thinking: ${block.status}]`, block.text, true));
        break;
      case 'tool_use': {
        const status = block.status ? ` status=${block.status}` : '';
        lines.push(truncateLine(`[tool: ${formatTerminalText(block.name)}${status}]`));
        lines.push(truncateLine(`  input: ${JSON.stringify(block.input)}`));
        if (block.result_content !== undefined) {
          lines.push(...formatHistoryText('  result:', block.result_content, true));
        }
        break;
      }
      case 'tool_result':
        lines.push(...formatHistoryText(
          `[tool result: ${block.status}]`,
          block.content,
          true,
        ));
        break;
      case 'execution_accepted':
        lines.push(truncateLine(
          `[tool accepted: ${formatTerminalText(block.execution_id)}]`,
        ));
        break;
      case 'image':
        lines.push(truncateLine(
          `[image: ${formatTerminalText(block.source.media_type)} `
            + `${block.dimensions.width}x${block.dimensions.height}]`,
        ));
        break;
    }
  }
  return lines.length > 0 ? lines : [roleLabel];
}

function formatSessionHistory(page: SessionHistoryPage): string[] {
  const recordLines = page.items.map(formatHistoryMessage);
  const maxContentLines = SESSION_HISTORY_MAX_LINES - 3;
  const selected: string[][] = [];
  let selectedLineCount = 0;
  let earlierOmitted = page.hasMore;
  let contentOmitted = false;

  for (let index = recordLines.length - 1; index >= 0; index -= 1) {
    const lines = recordLines[index]!;
    const remaining = maxContentLines - selectedLineCount;
    if (lines.length <= remaining) {
      selected.unshift(lines);
      selectedLineCount += lines.length;
      continue;
    }
    earlierOmitted = earlierOmitted || index > 0;
    if (selected.length === 0 && remaining > 0) {
      selected.unshift(lines.slice(0, remaining));
      selectedLineCount += remaining;
      contentOmitted = true;
    } else {
      earlierOmitted = true;
    }
    break;
  }

  const lines = ['[Recent session history]'];
  if (earlierOmitted) lines.push('[Earlier session history not shown]');
  for (const record of selected) lines.push(...record);
  if (contentOmitted) lines.push('[Some recent session history content omitted]');
  if (page.items.length === 0) lines.push('  No persisted history.');

  const charCount = lines.reduce((total, line) => total + line.length + 1, 0);
  if (lines.length > SESSION_HISTORY_MAX_LINES || charCount > SESSION_HISTORY_MAX_CHARS) {
    throw new Error('CLI Session history formatter exceeded its output budget.');
  }
  return lines;
}

export interface CliChannelConfig {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: string;
  /** 启用审批交互；启用时收到审批请求会阻塞 readline 等待 y/n */
  approval?: boolean;
}

export class CliChannel implements Channel {
  readonly id = 'cli';
  readonly completion: Promise<ChannelCompletion>;
  readonly interaction?: ChannelInteractionAdapter;

  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly promptText: string;
  private sessionId?: string;
  private rl?: readline.Interface;

  private messageHandler?: (req: ChannelRunRequest) => Promise<void>;
  private interactionResponseHandler?: (response: TurnInteractionResponse) => void;

  /** 流式输出过程中插入 tool/error 行前需要先换行；run_end / 显式插入会重置 */
  private inStream = false;
  private thinkingStream = false;
  private stopped = false;
  private started = false;
  private stopRequested = false;
  private settleCompletion!: (result: ChannelCompletion) => void;
  private completionSettled = false;
  /** 当前 readline.question 的 AbortController，用于 closure/stop 时取消底层读操作 */
  private pendingPromptAbort?: AbortController;
  private approvalPromptAbort?: AbortController;
  private approvalPromptCompletion?: Promise<void>;
  private cancelApprovalPrompt?: () => void;
  // ── Abort / Ctrl+C 状态（core-abort-spec.md §12）─────────────
  /** 上次 Ctrl+C 时间戳（epoch ms）；0 = 没有近期按键。用于双击检测。 */
  private lastCtrlCAt = 0;
  /** Runtime Composition 在 start 前注入；未绑定时模型查询和首次 Session 创建不可用。 */
  private runtimeCapabilities?: ChannelRuntimeCapabilities;
  private selectedModelOverride?: ModelReference;
  private thinkingSelection: ThinkingSelection = 'default';
  private effortSelection: ThinkingEffort = 'default';

  constructor(config: CliChannelConfig = {}) {
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
    this.promptText = config.prompt ?? '> ';
    this.completion = new Promise<ChannelCompletion>((resolve) => {
      this.settleCompletion = (result) => {
        if (this.completionSettled) return;
        this.completionSettled = true;
        resolve(Object.freeze(result));
      };
    });

    if (config.approval) {
      this.interaction = this.makeInteractionAdapter();
    }
  }

  // ── Channel.send 实现 ───────────────────────────────────────────────

  send(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        if (this.thinkingStream) {
          this.breakStream();
          this.thinkingStream = false;
        }
        this.inStream = true;
        this.output.write(event.text);
        break;

      case 'thinking_start':
        this.breakStream();
        this.thinkingStream = true;
        this.output.write(dim('[thinking]\n'));
        break;

      case 'thinking_delta':
        this.inStream = true;
        this.output.write(dim(event.text));
        break;

      case 'thinking_end':
        this.breakStream();
        this.thinkingStream = false;
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
        this.thinkingStream = false;
        this.output.write(dim(`[tool: ${event.name}]\n`));
        break;

      case 'tool_result': {
        const label = event.result.status === 'success'
          ? dim('[tool result]')
          : event.result.status === 'denied'
            ? yellow('[tool denied]')
            : event.result.status === 'aborted'
              ? yellow('[tool aborted]')
              : red('[tool error]');
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
        this.thinkingStream = false;
        break;

      case 'run_end':
        this.breakStream();
        this.thinkingStream = false;
        if (event.result.stopReason === 'max_llm_calls') {
          this.output.write(yellow('[configured model call limit reached]\n'));
        }
        break;

      case 'request_end':
        // CLI currently has no per-request queued presentation to clear.
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
    });
  }

  // ── 生命周期 ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.messageHandler) {
      const error = new Error('CliChannel.start: no message handler registered');
      this.settleCompletion({ outcome: 'failed', phase: 'startup', error });
      throw error;
    }

    this.started = true;
    this.stopped = false;
    this.stopRequested = false;

    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: true,
    });

    // readline 关闭时也视作 stop
    this.rl.on('close', () => {
      this.stopped = true;
      this.settleCompletion({
        outcome: 'closed',
        reason: this.stopRequested ? 'stopped' : 'input_closed',
      });
      log.info('cli channel readline closed', {
        channelId: this.id,
        sessionId: this.sessionId,
      });
    });

    // 【关键】给 rl 实例挂 SIGINT listener 才能拦截 readline 的 default 行为
    // （空 prompt 收到 ^C 会 emit 'SIGINT' + rl.close()）。挂了 listener 后
    // readline 只 emit 'SIGINT' 而不再 close，控制权交给 handleSigInt。
    // 未挂时 readline 会调 `process.kill(process.pid, 'SIGINT')` 让 process-
    // level handler 兜底——但空 prompt 那条路径同时会关掉 rl，等价于直接退出。
    this.rl.on('SIGINT', () => this.handleSigInt());

    log.info('cli channel started', {
      channelId: this.id,
      approvalEnabled: !!this.interaction,
    });

    void this.runInputLoop();
  }

  private async runInputLoop(): Promise<void> {
    const messageHandler = this.messageHandler;
    if (!messageHandler) return;
    try {
      while (!this.stopped) {
        let line: string;
        try {
          line = await this.question(this.promptText);
        } catch (error) {
          if (error === PROMPT_PREEMPTED_BY_APPROVAL) {
            await this.approvalPromptCompletion;
            continue;
          }
          // rl.close() 引发 question reject → 退出循环
          break;
        }

        if (this.stopped) break;

        const trimmed = line.trim();
        if (!trimmed) continue;

        log.info('cli input received', {
          channelId: this.id,
          sessionId: this.sessionId,
          length: trimmed.length,
        });

        try {
          if (this.handleHelpCommand(line)) continue;
          if (await this.handleReasoningCommand(line)) continue;
          if (await this.handleSessionCommand(line)) continue;
          if (await this.handlePermissionCommand(line)) continue;
          if (await this.handleModelCommand(line)) continue;
          const snapshot = this.getModelCatalog();
          if (this.selectedModelOverride) {
            if (!snapshot || !hasCatalogModel(snapshot, this.selectedModelOverride)) {
              this.breakStream();
              this.output.write(red(
                `[model unavailable] ${formatReference(this.selectedModelOverride)} is not in the current Catalog.\n`,
              ));
              continue;
            }
          }
          this.reconcileReasoningSelections(snapshot, 'the effective Model changed');
          const sessionId = await this.getOrCreateSessionId();
          const reasoning = this.getReasoningPreference();
          await messageHandler({
            sessionId,
            message: trimmed,
            ...(this.selectedModelOverride
              ? { modelReference: { ...this.selectedModelOverride } }
              : {}),
            ...(reasoning === undefined ? {} : { reasoning }),
          });
          log.debug('cli input dispatched', {
            channelId: this.id,
            sessionId,
          });
        } catch (err) {
          if (err === PROMPT_PREEMPTED_BY_APPROVAL) {
            await this.approvalPromptCompletion;
            continue;
          }
          const message = err instanceof Error ? err.message : String(err);
          this.breakStream();
          this.output.write(red(`[error] ${message}\n`));
          log.error('cli message handling failed', {
            channelId: this.id,
            sessionId: this.sessionId,
            error: message,
          });
        }
      }

      this.settleCompletion({
        outcome: 'closed',
        reason: this.stopRequested ? 'stopped' : 'input_closed',
      });
      log.info('cli channel stopped', {
        channelId: this.id,
        sessionId: this.sessionId,
      });
    } catch (error) {
      this.settleCompletion({
        outcome: 'failed',
        phase: 'runtime',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private handleHelpCommand(input: string): boolean {
    if (input !== '/help') return false;
    this.breakStream();
    this.output.write(cyan('[help]\n'));
    this.output.write([
      '  Model',
      '    /models                                      List available Models',
      '    /model                                       Select a Model',
      '    /model default                               Use the Runtime default',
      '    /model <providerId> <JSON-string-modelId>    Select a Model directly',
      '  Reasoning',
      '    /reasoning                                   Show Model and reasoning status',
      '    /thinking                                    Select Thinking behavior',
      '    /thinking default|on|off                     Set Thinking directly',
      '    /effort                                      Select reasoning effort',
      '    /effort default|none|minimal|low|medium|high|xhigh|max',
      '  Sessions',
      '    /sessions                                    List persisted Sessions',
      '    /session                                     Select a Session',
      '    /session new                                 Start a new Session',
      '    /session use <sessionId>                     Select a Session directly',
      '    /session rename <JSON-string|null>           Rename the current Session',
      '    /session delete                              Delete the current Session',
      '  Permissions',
      '    /permission                                  Select a permission mode',
      '    /permission manual|allow_all                 Set permission mode directly',
      '  Process control',
      '    Ctrl+C                                       Abort work; press twice to exit',
      '',
    ].join('\n'));
    return true;
  }

  private async handleReasoningCommand(input: string): Promise<boolean> {
    if (
      input !== '/reasoning'
      && input !== '/thinking'
      && !input.startsWith('/thinking ')
      && input !== '/effort'
      && !input.startsWith('/effort ')
    ) {
      return false;
    }
    this.breakStream();

    if (input === '/reasoning') {
      const snapshot = this.getModelCatalog();
      this.renderReasoningStatus(snapshot);
      return true;
    }

    if (input === '/thinking') {
      const snapshot = this.getModelCatalog();
      if (!snapshot) return true;
      const supported = this.getSupportedThinking(snapshot);
      const result = await this.promptSelection(
        'thinking',
        THINKING_SELECTIONS
          .filter((value) => value === 'default' || supported.includes(value))
          .map((value) => ({
            value,
            label: value,
            current: value === this.thinkingSelection,
          })),
      );
      if (result.selected) this.applyThinkingSelection(result.value, snapshot);
      return true;
    }

    if (input.startsWith('/thinking ')) {
      const value = input.slice('/thinking '.length);
      if (!THINKING_SELECTIONS.includes(value as ThinkingSelection)) {
        this.renderThinkingUsage();
        return true;
      }
      if (value === 'default') {
        this.applyThinkingSelection('default');
        return true;
      }
      const snapshot = this.getModelCatalog();
      if (!snapshot) return true;
      this.applyThinkingSelection(value as ThinkingSelection, snapshot);
      return true;
    }

    if (input === '/effort') {
      const snapshot = this.getModelCatalog();
      if (!snapshot) return true;
      const supported = this.getSupportedEfforts(snapshot);
      const result = await this.promptSelection(
        'effort',
        EFFORT_SELECTIONS
          .filter((value) => value === 'default' || supported.includes(value))
          .map((value) => ({
            value,
            label: value,
            current: value === this.effortSelection,
          })),
      );
      if (result.selected) this.applyEffortSelection(result.value, snapshot);
      return true;
    }

    const value = input.slice('/effort '.length);
    if (!EFFORT_SELECTIONS.includes(value as ThinkingEffort)) {
      this.renderEffortUsage();
      return true;
    }
    if (value === 'default') {
      this.applyEffortSelection('default');
      return true;
    }
    const snapshot = this.getModelCatalog();
    if (!snapshot) return true;
    this.applyEffortSelection(value as ThinkingEffort, snapshot);
    return true;
  }

  private renderReasoningStatus(snapshot: ModelCatalogSnapshot | undefined): void {
    const effective = snapshot
      ? getEffectiveModelReference(snapshot, this.selectedModelOverride)
      : undefined;
    this.output.write(cyan('[reasoning]\n'));
    this.output.write(`  Model: ${effective ? formatReference(effective) : 'unavailable'}\n`);
    this.output.write(`  Thinking: ${this.thinkingSelection}\n`);
    this.output.write(`  Effort: ${this.effortSelection}\n`);
    if (!snapshot) {
      this.output.write('  Supported Thinking: unavailable\n');
      this.output.write('  Supported effort: unavailable\n');
      return;
    }
    const thinking = this.getSupportedThinking(snapshot);
    const efforts = this.getSupportedEfforts(snapshot);
    this.output.write(`  Supported Thinking: ${thinking.join(', ') || 'none'}\n`);
    this.output.write(`  Supported effort: ${efforts.join(', ') || 'none'}\n`);
  }

  private getSupportedThinking(snapshot: ModelCatalogSnapshot): readonly ThinkingSwitch[] {
    const model = this.getEffectiveCatalogModel(snapshot);
    return model?.capabilities?.reasoning?.thinking ?? [];
  }

  private getSupportedEfforts(snapshot: ModelCatalogSnapshot): readonly Exclude<
    ThinkingEffort,
    'default'
  >[] {
    const model = this.getEffectiveCatalogModel(snapshot);
    return model?.capabilities?.reasoning?.efforts ?? [];
  }

  private getEffectiveCatalogModel(snapshot: ModelCatalogSnapshot): ModelCatalogEntry | undefined {
    const reference = getEffectiveModelReference(snapshot, this.selectedModelOverride);
    return reference ? findCatalogModel(snapshot, reference) : undefined;
  }

  private applyThinkingSelection(
    value: ThinkingSelection,
    snapshot?: ModelCatalogSnapshot,
  ): void {
    if (
      value !== 'default'
      && (!snapshot || !this.getSupportedThinking(snapshot).includes(value))
    ) {
      this.output.write(red(`[thinking error] ${value} is not supported by the effective Model.\n`));
      return;
    }
    if (!this.isReasoningCombinationValid(value, this.effortSelection)) {
      this.output.write(red(
        `[thinking error] thinking=${value} cannot be combined with effort=${this.effortSelection}.\n`,
      ));
      return;
    }
    this.thinkingSelection = value;
    this.output.write(cyan(`[thinking] ${value}\n`));
  }

  private applyEffortSelection(
    value: ThinkingEffort,
    snapshot?: ModelCatalogSnapshot,
  ): void {
    if (
      value !== 'default'
      && (!snapshot || !this.getSupportedEfforts(snapshot).includes(value))
    ) {
      this.output.write(red(`[effort error] ${value} is not supported by the effective Model.\n`));
      return;
    }
    if (!this.isReasoningCombinationValid(this.thinkingSelection, value)) {
      this.output.write(red(
        `[effort error] thinking=${this.thinkingSelection} cannot be combined with effort=${value}.\n`,
      ));
      return;
    }
    this.effortSelection = value;
    this.output.write(cyan(`[effort] ${value}\n`));
  }

  private isReasoningCombinationValid(
    thinking: ThinkingSelection,
    effort: ThinkingEffort,
  ): boolean {
    try {
      normalizeReasoningPreference({
        ...(thinking === 'default' ? {} : { thinking }),
        effort,
      });
      return true;
    } catch (error) {
      if (!(error instanceof ReasoningPreferenceValidationError)) throw error;
      return false;
    }
  }

  private reconcileReasoningSelections(
    snapshot: ModelCatalogSnapshot | undefined,
    reason: string,
  ): void {
    const effective = snapshot
      ? getEffectiveModelReference(snapshot, this.selectedModelOverride)
      : undefined;
    const modelLabel = effective ? formatReference(effective) : 'no effective Model';
    const supportedThinking = snapshot ? this.getSupportedThinking(snapshot) : [];
    const supportedEfforts = snapshot ? this.getSupportedEfforts(snapshot) : [];

    if (
      this.thinkingSelection !== 'default'
      && !supportedThinking.includes(this.thinkingSelection)
    ) {
      const previous = this.thinkingSelection;
      this.thinkingSelection = 'default';
      this.output.write(yellow(
        `[reasoning] thinking reset from ${previous} to default for ${modelLabel}: ${reason}.\n`,
      ));
    }
    if (
      this.effortSelection !== 'default'
      && !supportedEfforts.includes(this.effortSelection)
    ) {
      const previous = this.effortSelection;
      this.effortSelection = 'default';
      this.output.write(yellow(
        `[reasoning] effort reset from ${previous} to default for ${modelLabel}: ${reason}.\n`,
      ));
    }
  }

  private getReasoningPreference(): ReasoningPreference | undefined {
    if (this.thinkingSelection === 'default' && this.effortSelection === 'default') {
      return undefined;
    }
    return normalizeReasoningPreference({
      ...(this.thinkingSelection === 'default'
        ? {}
        : { thinking: this.thinkingSelection }),
      effort: this.effortSelection,
    }).preference;
  }

  private renderThinkingUsage(): void {
    this.output.write(red('[thinking error] usage: /thinking | /thinking default|on|off\n'));
  }

  private renderEffortUsage(): void {
    this.output.write(red(
      '[effort error] usage: /effort | /effort default|none|minimal|low|medium|high|xhigh|max\n',
    ));
  }

  private async handleSessionCommand(input: string): Promise<boolean> {
    if (input !== '/sessions' && input !== '/session' && !input.startsWith('/session ')) {
      return false;
    }
    this.breakStream();
    const capability = this.runtimeCapabilities?.sessions;
    if (!capability) {
      this.output.write(red('[session unavailable] Runtime Session capability is not bound.\n'));
      return true;
    }

    if (input === '/sessions') {
      const sessions = await capability.listSessions();
      this.output.write(cyan('[sessions]\n'));
      if (sessions.length === 0) {
        this.output.write(dim('  No persisted Sessions.\n'));
        return true;
      }
      for (const session of sessions) {
        const current = session.sessionId === this.sessionId ? ' [current]' : '';
        const title = session.title ? ` ${formatTerminalText(session.title)}` : '';
        this.output.write(`  ${session.sessionId}${current}${title}\n`);
      }
      return true;
    }

    if (input === '/session') {
      const sessions = await capability.listSessions();
      const options: CliSelectionOption<
        { readonly kind: 'new' }
        | { readonly kind: 'persisted'; readonly sessionId: string }
      >[] = [{
        value: { kind: 'new' },
        label: 'New Session',
        current: this.sessionId === undefined,
      }];
      for (const session of sessions) {
        options.push({
          value: { kind: 'persisted', sessionId: session.sessionId },
          label: `${session.sessionId}${session.title
            ? ` ${formatTerminalText(session.title)}`
            : ''}`,
          current: session.sessionId === this.sessionId,
        });
      }
      const result = await this.promptSelection('session', options);
      if (!result.selected) return true;
      if (result.value.kind === 'new') {
        this.selectNewSession();
      } else {
        await this.selectPersistedSession(result.value.sessionId, capability);
      }
      return true;
    }

    const payload = input.slice('/session '.length);
    if (payload === 'new') {
      this.selectNewSession();
      return true;
    }
    if (payload.startsWith('use ')) {
      const sessionId = payload.slice('use '.length).trim();
      if (!sessionId) {
        this.renderSessionUsage();
        return true;
      }
      await this.selectPersistedSession(sessionId, capability);
      return true;
    }
    if (payload.startsWith('rename ')) {
      if (!this.sessionId) {
        this.output.write(red('[session error] No persisted Session is selected.\n'));
        return true;
      }
      let title: unknown;
      try {
        title = JSON.parse(payload.slice('rename '.length));
      } catch {
        title = undefined;
      }
      if (title !== null && typeof title !== 'string') {
        this.renderSessionUsage();
        return true;
      }
      const session = await capability.renameSession(this.sessionId, title);
      this.output.write(cyan(
        `[session] renamed ${session.sessionId}${session.title ? ` ${formatTerminalText(session.title)}` : ''}.\n`,
      ));
      return true;
    }
    if (payload === 'delete') {
      if (!this.sessionId) {
        this.output.write(red('[session error] No persisted Session is selected.\n'));
        return true;
      }
      const deletedSessionId = this.sessionId;
      await capability.deleteSession(deletedSessionId);
      this.sessionId = undefined;
      this.output.write(cyan(`[session] deleted ${deletedSessionId}.\n`));
      return true;
    }

    this.renderSessionUsage();
    return true;
  }

  private selectNewSession(): void {
    this.sessionId = undefined;
    this.output.write(cyan('[session] new; the first message will create it.\n'));
  }

  private async selectPersistedSession(
    sessionId: string,
    capability: SessionCapability,
  ): Promise<void> {
    const session = await capability.getSession(sessionId);
    this.sessionId = session.sessionId;
    this.output.write(cyan(
      `[session] current ${session.sessionId}${session.title
        ? ` ${formatTerminalText(session.title)}`
        : ''}.\n`,
    ));
    try {
      const page = await capability.getHistory({
        sessionId: session.sessionId,
        limit: SESSION_HISTORY_LIMIT,
      });
      for (const line of formatSessionHistory(page)) {
        this.output.write(dim(line) + '\n');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.write(red(
        `[session history error] Unable to display recent history: ${formatTerminalText(message)}\n`,
      ));
    }
  }

  private renderSessionUsage(): void {
    this.output.write(red(
      '[session error] usage: /sessions | /session | /session new | /session use <sessionId> | /session rename <JSON-string|null> | /session delete\n',
    ));
  }

  private async handlePermissionCommand(input: string): Promise<boolean> {
    if (input !== '/permission' && !input.startsWith('/permission ')) return false;
    this.breakStream();
    const capability = this.runtimeCapabilities?.sessions;
    if (!capability) {
      this.output.write(red('[permission unavailable] Runtime Session capability is not bound.\n'));
      return true;
    }
    if (!this.sessionId) {
      this.output.write(red(
        '[permission error] No persisted Session is selected; send the first message first.\n',
      ));
      return true;
    }

    const mode = input.slice('/permission'.length).trim();
    if (!mode) {
      const permission = capability.getPermissionMode(this.sessionId);
      const result = await this.promptSelection<'manual' | 'allow_all'>(
        'permission',
        [
          {
            value: 'manual',
            label: 'manual (individual approvals required)',
            current: permission.mode === 'manual',
          },
          {
            value: 'allow_all',
            label: 'allow_all (Allow all for this Session)',
            current: permission.mode === 'allow_all',
          },
        ],
      );
      if (result.selected) {
        await this.applyPermissionMode(result.value, capability);
      }
      return true;
    }
    if (mode !== 'manual' && mode !== 'allow_all') {
      this.renderPermissionUsage();
      return true;
    }
    await this.applyPermissionMode(mode, capability);
    return true;
  }

  private async applyPermissionMode(
    mode: 'manual' | 'allow_all',
    capability: SessionCapability,
  ): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error('Cannot set permission mode without a persisted Session.');
    }
    if (mode === 'allow_all') {
      this.output.write(yellow(
        '[warning] Allow All runs every non-denied tool without asking. Shell commands and '
          + 'external filesystem changes are possible; executable and dependency integrity '
          + 'is not verified. It remains active after disconnect until revoked, archived, '
          + 'deleted, or Runtime restart.\n',
      ));
      const answer = await this.question(yellow('Type ALLOW ALL to confirm> '));
      if (answer.trim() !== 'ALLOW ALL') {
        this.output.write(yellow('[permission] unchanged; Allow All was not confirmed.\n'));
        return;
      }
    }
    const permission = capability.setPermissionMode({
      sessionId,
      mode,
    });
    this.output.write(cyan(
      `[permission] ${permission.mode === 'allow_all'
        ? 'allow_all (Allow all for this Session)'
        : 'manual (individual approvals required)'}\n`,
    ));
  }

  private renderPermissionUsage(): void {
    this.output.write(red('[permission error] usage: /permission | /permission manual | /permission allow_all\n'));
  }

  private async handleModelCommand(input: string): Promise<boolean> {
    if (input !== '/models' && input !== '/model' && !input.startsWith('/model ')) {
      return false;
    }
    this.breakStream();
    const snapshot = this.getModelCatalog();
    if (!snapshot) return true;

    if (input === '/models') {
      this.renderModelCatalog(snapshot);
      return true;
    }
    if (input === '/model') {
      const defaultLabel = snapshot.defaultSelection.state === 'available'
        ? `Runtime default (${formatReference(snapshot.defaultSelection.reference)})`
        : snapshot.defaultSelection.state === 'unavailable'
          ? `Runtime default (${formatReference(snapshot.defaultSelection.reference)}, unavailable)`
          : 'Runtime default (unset)';
      const options: CliSelectionOption<
        { readonly kind: 'default' }
        | { readonly kind: 'model'; readonly reference: ModelReference }
      >[] = [{
        value: { kind: 'default' },
        label: defaultLabel,
        current: this.selectedModelOverride === undefined,
      }];
      for (const provider of snapshot.providers) {
        for (const model of provider.models) {
          const reference = { providerId: provider.providerId, modelId: model.modelId };
          options.push({
            value: { kind: 'model', reference },
            label: `${formatTerminalText(model.displayName)} (${formatReference(reference)})`,
            current: sameReference(reference, this.selectedModelOverride),
          });
        }
      }
      const result = await this.promptSelection('model', options);
      if (!result.selected) return true;
      if (result.value.kind === 'default') {
        this.applyModelSelection(undefined, snapshot);
      } else {
        this.applyModelSelection(result.value.reference, snapshot);
      }
      return true;
    }

    const payload = input.slice('/model '.length);
    if (payload === 'default') {
      this.applyModelSelection(undefined, snapshot);
      return true;
    }
    const separator = payload.indexOf(' ');
    const providerId = separator > 0 ? payload.slice(0, separator) : '';
    const encodedModelId = separator > 0 ? payload.slice(separator + 1) : '';
    let modelId: unknown;
    try {
      modelId = JSON.parse(encodedModelId);
    } catch {
      modelId = undefined;
    }
    if (!providerId || typeof modelId !== 'string') {
      this.output.write(red(
        '[model error] usage: /model <providerId> <JSON-string-modelId> | /model default\n',
      ));
      return true;
    }

    const reference = Object.freeze({ providerId, modelId });
    if (!hasCatalogModel(snapshot, reference)) {
      this.output.write(red(
        `[model error] ${formatReference(reference)} is not in generation ${snapshot.generation}.\n`,
      ));
      return true;
    }
    this.applyModelSelection(reference, snapshot);
    return true;
  }

  private applyModelSelection(
    reference: ModelReference | undefined,
    snapshot: ModelCatalogSnapshot,
  ): void {
    this.selectedModelOverride = reference;
    if (reference) {
      this.output.write(cyan(`[model] override set to ${formatReference(reference)}.\n`));
    } else {
      this.output.write(cyan('[model] override cleared; using Runtime default.\n'));
      this.renderModelStatus(snapshot);
    }
    this.reconcileReasoningSelections(snapshot, 'the Model selection changed');
  }

  private async getOrCreateSessionId(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    // Entering the new-Session state does not allocate an ID; the first message does.
    const capability = this.runtimeCapabilities?.sessions;
    if (!capability) {
      throw new Error('Runtime Session capability is not bound.');
    }
    const { sessionId } = await capability.createSession();
    this.sessionId = sessionId;
    return sessionId;
  }

  private getModelCatalog(): ModelCatalogSnapshot | undefined {
    if (!this.runtimeCapabilities) {
      this.output.write(red('[model unavailable] Runtime Model Catalog is not bound.\n'));
      return undefined;
    }
    try {
      return this.runtimeCapabilities.modelCatalog.getSnapshot();
    } catch {
      this.output.write(red('[model unavailable] Runtime Model Catalog is not ready.\n'));
      return undefined;
    }
  }

  private renderModelCatalog(snapshot: ModelCatalogSnapshot): void {
    this.output.write(cyan(`[models] generation ${snapshot.generation}\n`));
    if (snapshot.providers.length === 0) {
      this.output.write(dim('  No models are currently available.\n'));
      return;
    }
    const defaultReference = snapshot.defaultSelection.state === 'available'
      ? snapshot.defaultSelection.reference
      : undefined;
    for (const provider of snapshot.providers) {
      this.output.write(`${formatTerminalText(provider.displayName)} (${provider.providerId})\n`);
      for (const model of provider.models) {
        const reference = { providerId: provider.providerId, modelId: model.modelId };
        const markers = [
          ...(sameReference(reference, defaultReference) ? ['default'] : []),
          ...(sameReference(reference, this.selectedModelOverride) ? ['override'] : []),
        ];
        this.output.write(
          `  ${formatTerminalText(model.displayName)} (${formatModelId(model.modelId)})${markers.length ? ` [${markers.join(', ')}]` : ''}\n`,
        );
      }
    }
  }

  private renderModelStatus(snapshot: ModelCatalogSnapshot): void {
    const override = this.selectedModelOverride;
    this.output.write(`[model] override: ${override ? formatReference(override) : 'none'}\n`);
    switch (snapshot.defaultSelection.state) {
      case 'unset':
        this.output.write('[model] default: unset\n');
        break;
      case 'available':
        this.output.write(
          `[model] default: ${formatReference(snapshot.defaultSelection.reference)} (available)\n`,
        );
        break;
      case 'unavailable':
        this.output.write(
          `[model] default: ${formatReference(snapshot.defaultSelection.reference)} (unavailable: ${snapshot.defaultSelection.reason})\n`,
        );
        break;
    }
    const effective = override
      ?? (snapshot.defaultSelection.state === 'available'
        ? snapshot.defaultSelection.reference
        : undefined);
    this.output.write(`[model] effective: ${effective ? formatReference(effective) : 'none'}\n`);
  }

  async stop(): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.stopped = true;
    log.info('cli channel stopping', {
      channelId: this.id,
      sessionId: this.sessionId,
    });
    this.pendingPromptAbort?.abort(new Error('CliChannel stopped'));
    this.rl?.close();
    this.rl = undefined;
    this.settleCompletion({ outcome: 'closed', reason: 'stopped' });
  }

  // ── Abort / Ctrl+C 处理（core-abort-spec.md §12）────────────────

  bindRuntimeCapabilities(capabilities: ChannelRuntimeCapabilities): void {
    this.runtimeCapabilities = capabilities;
    log.debug('Runtime capabilities bound', { channelId: this.id });
  }

  /**
   * SIGINT 处理主干。精确语义见 core-abort-spec.md §12：
   *
  *  1. 若上一次在窗口内→ 关闭 readline；进程退出策略属于 Host。
   *  2. 更新 lastCtrlCAt（为双击窗口计时）。
   *  3. 查 `querySessionsNeedingAbort()`：
   *     - 空（无 active turn + 无 queue）→ 仅提示 "press again to exit"，不调 abort。
  *     - 非空→ 对每个 sessionId 调 `capabilities.abort.abortTurn(sessionId)`，依返回值中
   *       `aborted` / `dropped` 非零部分拼提示（可能只有其中一部分）。
   *
  * Runtime capabilities 未 bind 时直接当作 “无东西可 abort” 处理（退到提示分支），
   * 支持 CliChannel 单独跑（不接 RuntimeApp）下 Ctrl+C 仍能双击退出。
   */
  private handleSigInt(): void {
    const now = Date.now();
    const sinceLast = now - this.lastCtrlCAt;

    // 双击：窗口内连按两次 → 关闭本 Channel；Host 随后 cooperative shutdown。
    if (this.lastCtrlCAt > 0 && sinceLast <= CTRL_C_EXIT_WINDOW_MS) {
      this.breakStream();
      this.output.write(red('[exiting]\n'));
      log.info('cli input closing on double Ctrl+C', { channelId: this.id });
      this.rl?.close();
      return;
    }

    this.lastCtrlCAt = now;

    // 【与 D3 语义一致】判断 “是否有东西可 abort” 时必须同时考虑：
    //  (i) 有 active turn（→ 会被 abort）
    //  (ii) 有 queued messages（→ 会被 drop）
    // 仅两者都为空时才提示 "press again to exit"；否则统一走 abortTurn 路径。
    // 详见 core-abort-spec.md §12。
    const targets = this.runtimeCapabilities?.abort.querySessionsNeedingAbort() ?? [];
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
      const r = this.runtimeCapabilities!.abort.abortTurn(sk);
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

  private question(prompt: string, kind: 'ordinary' | 'approval' = 'ordinary'): Promise<string> {
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
        if (this.approvalPromptAbort === controller) {
          this.approvalPromptAbort = undefined;
        }
        controller.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        clear();
        reject(controller.signal.reason);
      };
      this.pendingPromptAbort = controller;
      if (kind === 'approval') this.approvalPromptAbort = controller;
      controller.signal.addEventListener('abort', onAbort, { once: true });
      this.rl.question(prompt, { signal: controller.signal }, (answer) => {
        clear();
        resolve(answer);
      });
    });
  }

  private async promptSelection<T>(
    name: string,
    options: readonly CliSelectionOption<T>[],
  ): Promise<CliSelectionResult<T>> {
    if (options.length === 0) {
      this.output.write(red(`[${name} error] No selectable options are available.\n`));
      return { selected: false };
    }
    this.output.write(cyan(`[select ${name}]\n`));
    options.forEach((option, index) => {
      this.output.write(
        `  ${index + 1}. ${option.label}${option.current ? ' [current]' : ''}\n`,
      );
    });
    const answer = await this.question(
      cyan(`Select ${name} [1-${options.length}, blank to cancel]> `),
    );
    const value = answer.trim();
    if (!value) {
      this.output.write(dim(`[${name}] unchanged.\n`));
      return { selected: false };
    }
    if (!/^[1-9]\d*$/u.test(value)) {
      this.output.write(red(`[${name} error] Selection must be a listed number.\n`));
      return { selected: false };
    }
    const option = options[Number(value) - 1];
    if (!option) {
      this.output.write(red(`[${name} error] Selection is out of range.\n`));
      return { selected: false };
    }
    return { selected: true, value: option.value };
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
      routedAs: 'interaction',
    });

    if (this.interactionResponseHandler) {
      this.interactionResponseHandler({
        id,
        kind: 'approval',
        outcome: 'submitted',
        decision,
      });
    }
  }

  private promptApproval(
    request: Pick<ApprovalRequest, 'id' | 'toolName' | 'input'>,
    onDecision: (decision: ApprovalDecision) => void,
  ): { status: 'accepted' } | { status: 'unavailable'; reason: 'delivery_failed' } {
    if (!this.rl) {
      return { status: 'unavailable', reason: 'delivery_failed' };
    }
    if (this.approvalPromptCompletion) {
      return { status: 'unavailable', reason: 'delivery_failed' };
    }
    this.breakStream();
    this.output.write(
      yellow(
        `[approval] tool: ${request.toolName}\n           input: ${JSON.stringify(request.input)}\n`,
      ),
    );
    let settleApprovalPrompt!: () => void;
    const completion = new Promise<void>((resolve) => {
      settleApprovalPrompt = resolve;
    });
    this.approvalPromptCompletion = completion;
    let finished = false;
    const finishApprovalPrompt = () => {
      if (finished) return;
      finished = true;
      if (this.approvalPromptCompletion === completion) {
        this.approvalPromptCompletion = undefined;
        this.cancelApprovalPrompt = undefined;
      }
      settleApprovalPrompt();
    };
    this.cancelApprovalPrompt = () => {
      if (this.approvalPromptAbort) {
        this.approvalPromptAbort.abort(new Error('Approval closed'));
      } else {
        finishApprovalPrompt();
      }
    };
    const startApprovalPrompt = () => {
      if (finished) return;
      void this.question(yellow('approve? (y/n)> '), 'approval').then(
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
          log.debug('cli approval prompt aborted', {
            channelId: this.id,
            approvalId: request.id,
          });
        },
      ).finally(finishApprovalPrompt);
    };
    if (this.pendingPromptAbort) {
      this.pendingPromptAbort.abort(PROMPT_PREEMPTED_BY_APPROVAL);
      queueMicrotask(startApprovalPrompt);
    } else {
      startApprovalPrompt();
    }
    return { status: 'accepted' };
  }

  private closeApproval(id: string, result: ApprovalClosedResult): void {
    this.cancelApprovalPrompt?.();
    this.output.write(yellow(`\n[approval] closed (${result.outcome})\n`));
    log.info('cli approval closed', {
      channelId: this.id,
      approvalId: id,
      outcome: result.outcome,
    });
  }
}
