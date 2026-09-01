import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentEvent } from '../../core/runner/types.js';
import type { AbortHookBindings } from './types.js';
import { CliChannel } from './CliChannel.js';

// Strip ANSI escape sequences so assertions don't fight color codes.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function makeChannel(approval = false): { channel: CliChannel; captured: () => string } {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (c: Buffer) => chunks.push(c));
  const channel = new CliChannel({
    input: new PassThrough(),
    output: output as unknown as NodeJS.WritableStream,
    approval,
  });
  return {
    channel,
    captured: () => stripAnsi(Buffer.concat(chunks).toString('utf-8')),
  };
}

describe('CliChannel user_message rendering', () => {
  it('WS-origin message: renders [user @clientp] hello', () => {
    const { channel, captured } = makeChannel();
    const event: AgentEvent = {
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'msg-1',
      content: 'hello there',
      originClientId: 'client-prefix-suffix',
      deliveryMode: 'queued',
      timestamp: Date.now(),
    };
    channel.send(event);
    const out = captured();
    // client id is truncated to 6 chars in the tag
    expect(out).toContain('[user @client]');
    expect(out).toContain('hello there');
  });

  it('null-origin message (CLI / library entry): no output', () => {
    const { channel, captured } = makeChannel();
    channel.send({
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'msg-2',
      content: 'from cli',
      originClientId: null,
      deliveryMode: 'queued',
      timestamp: Date.now(),
    });
    expect(captured()).toBe('');
  });

  it('single attachment: appends (+1 attachment) hint', () => {
    const { channel, captured } = makeChannel();
    channel.send({
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'msg-3',
      content: 'look',
      attachmentSummaries: [{ type: 'image', mime: 'image/png', bytes: 1024 }],
      originClientId: 'abcdef123',
      deliveryMode: 'queued',
      timestamp: Date.now(),
    });
    const out = captured();
    expect(out).toContain('look');
    expect(out).toContain('(+1 attachment)');
  });

  it('multiple attachments: pluralizes to (+N attachments)', () => {
    const { channel, captured } = makeChannel();
    channel.send({
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'msg-4',
      content: 'many',
      attachmentSummaries: [
        { type: 'image' },
        { type: 'image' },
        { type: 'other' },
      ],
      originClientId: 'abcdef123',
      deliveryMode: 'queued',
      timestamp: Date.now(),
    });
    expect(captured()).toContain('(+3 attachments)');
  });

  it('breaks streaming text with a newline before rendering user_message', () => {
    const { channel, captured } = makeChannel();
    channel.send({ type: 'text_delta', sessionKey: 'main', turnId: 't1', text: 'streaming...' });
    channel.send({
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'msg-5',
      content: 'inject',
      originClientId: 'abcdef123',
      deliveryMode: 'steering',
      timestamp: Date.now(),
    });
    const out = captured();
    // must contain a newline between the delta and the [user ...] tag
    expect(out).toMatch(/streaming\.\.\.\n\[user @abcdef\] inject/);
  });

  it('never leaks raw attachment bytes/mime into the rendered line', () => {
    const { channel, captured } = makeChannel();
    channel.send({
      type: 'user_message',
      sessionKey: 'main',
      messageId: 'msg-6',
      content: 'x',
      attachmentSummaries: [
        { type: 'image', mime: 'image/png', bytes: 999999, name: 'secret.png' },
      ],
      originClientId: 'abcdef123',
      deliveryMode: 'queued',
      timestamp: Date.now(),
    });
    const out = captured();
    expect(out).not.toContain('secret.png');
    expect(out).not.toContain('999999');
    expect(out).not.toContain('image/png');
  });
});

describe('CliChannel approval lifecycle', () => {
  it('cancels the underlying readline question when approval closes', async () => {
    const { channel } = makeChannel(true);
    let questionSignal: AbortSignal | undefined;
    let answerQuestion: ((answer: string) => void) | undefined;
    (channel as unknown as {
      rl: {
        question(
          prompt: string,
          options: { signal: AbortSignal },
          callback: (answer: string) => void,
        ): void;
      };
    }).rl = {
      question(_prompt, options, callback) {
        questionSignal = options.signal;
        answerQuestion = callback;
      },
    };
    const responseHandler = vi.fn();
    channel.interaction?.onInteractionResponse(responseHandler);
    const request = {
      id: 'approval-1',
      kind: 'approval' as const,
      toolName: 'write_file',
      input: {},
      sessionKey: 'main',
      turnId: 'turn-1',
    };

    expect(channel.interaction?.sendInteractionRequest(request)).toEqual({ status: 'accepted' });
    expect(questionSignal?.aborted).toBe(false);

    channel.interaction?.sendInteractionClosed(request, {
      outcome: 'aborted',
      reason: 'turn',
    });
    expect(questionSignal?.aborted).toBe(true);
    answerQuestion?.('y');
    await Promise.resolve();
    expect(responseHandler).not.toHaveBeenCalled();
  });
});

// ── Ctrl+C / abort（core-abort-spec.md §12）─────────────────────────

describe('CliChannel Ctrl+C / abort handling', () => {
  // handleSigInt 是 private——测试通过桥接类型直接调用，避免依赖 process.emit
  // 触发全局 SIGINT listener（会牵动 vitest 自己装的 handler）。start() 里
  // 装 handler 的行为由 spec §12 的 code review 保证；这里只测行为矩阵。
  type CliChannelInternal = { handleSigInt(): void };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHooks(
    partial: Partial<AbortHookBindings> = {},
  ): { hooks: AbortHookBindings; abortTurn: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
    const abortTurn = vi.fn(
      partial.abortTurn ?? (() => ({ aborted: false, dropped: 0 })),
    );
    const query = vi.fn(partial.querySessionsNeedingAbort ?? (() => []));
    return {
      hooks: { querySessionsNeedingAbort: query, abortTurn },
      abortTurn,
      query,
    };
  }

  it('single Ctrl+C with an active turn → calls abortHooks.abortTurn and renders "[⚠ aborted N turn(s)]"', () => {
    const { channel, captured } = makeChannel();
    const { hooks, abortTurn, query } = makeHooks({
      querySessionsNeedingAbort: () => ['main'],
      abortTurn: () => ({ aborted: true, dropped: 0 }),
    });
    channel.bindAbortHooks(hooks);

    (channel as unknown as CliChannelInternal).handleSigInt();

    expect(query).toHaveBeenCalledTimes(1);
    expect(abortTurn).toHaveBeenCalledTimes(1);
    expect(abortTurn).toHaveBeenCalledWith('main');
    const out = captured();
    expect(out).toContain('aborted 1 turn(s)');
    // No "dropped ..." fragment because dropped === 0
    expect(out).not.toMatch(/dropped \d+ queued message/);
    // Does not enter "press again to exit" hint path
    expect(out).not.toContain('press Ctrl+C again');
  });

  it('double Ctrl+C within 1s → calls process.exit(130)', () => {
    const { channel } = makeChannel();
    // Hooks bound but nothing to abort — makes the FIRST Ctrl+C fall into
    // the "press again to exit" branch (arms lastCtrlCAt) instead of the
    // abort path. Second Ctrl+C then trips the double-tap exit.
    channel.bindAbortHooks(makeHooks().hooks);

    // process.exit throws to unwind the current call stack — matches the
    // real-world "we never come back" semantic without actually killing
    // vitest. Cast return type via `never`.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit__:${code ?? ''}`);
    }) as never);

    const internal = channel as unknown as CliChannelInternal;
    internal.handleSigInt(); // first — arms lastCtrlCAt
    expect(exitSpy).not.toHaveBeenCalled();

    expect(() => internal.handleSigInt()).toThrow(/__test_exit__:130/);
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('hooks not bound (standalone CLI) → Ctrl+C renders exit hint and never crashes', () => {
    const { channel, captured } = makeChannel();

    // No bindAbortHooks call — abortHooks is undefined.
    expect(() =>
      (channel as unknown as CliChannelInternal).handleSigInt(),
    ).not.toThrow();

    const out = captured();
    expect(out).toContain('press Ctrl+C again within 1s to exit');
    expect(out).not.toMatch(/aborted \d+ turn/);
    expect(out).not.toMatch(/dropped \d+ queued/);
  });

  it('no active turn + non-empty queue → renders "dropped 3 queued message(s)" and omits "aborted N turn(s)"', () => {
    const { channel, captured } = makeChannel();
    const { hooks, abortTurn } = makeHooks({
      // querySessionsNeedingAbort returns sessions with queued msgs even
      // when there's no active turn (spec §12 note (ii)).
      querySessionsNeedingAbort: () => ['main'],
      // Runtime side: no active abort but 3 dropped messages.
      abortTurn: () => ({ aborted: false, dropped: 3 }),
    });
    channel.bindAbortHooks(hooks);

    (channel as unknown as CliChannelInternal).handleSigInt();

    expect(abortTurn).toHaveBeenCalledWith('main');
    const out = captured();
    expect(out).toContain('dropped 3 queued message(s)');
    // Critically: no "aborted 0 turn(s)" or "aborted N turn(s)" fragment
    // when totalAborted === 0.
    expect(out).not.toMatch(/aborted \d+ turn/);
  });
});
