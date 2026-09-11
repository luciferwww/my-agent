import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentEvent } from '../../core/runner/types.js';
import type {
  ChannelRuntimeCapabilities,
  DefaultModelSelection,
  TurnAbortCapability,
} from '../../core/channel/index.js';
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

describe('CliChannel lifecycle', () => {
  it('reports readiness before natural input closure settles completion', async () => {
    const existingSigIntListeners = process.listeners('SIGINT');
    const input = new PassThrough();
    const channel = new CliChannel({
      input,
      output: new PassThrough(),
    });
    channel.onMessage(async () => undefined);
    let completed = false;
    void channel.completion.then(() => {
      completed = true;
    });

    try {
      await channel.start();
      await Promise.resolve();
      expect(completed).toBe(false);

      input.end();
      await expect(channel.completion).resolves.toEqual({
        outcome: 'closed',
        reason: 'input_closed',
      });
    } finally {
      await channel.stop();
      process.removeAllListeners('SIGINT');
      for (const listener of existingSigIntListeners) {
        process.on('SIGINT', listener);
      }
    }
  });
});

describe('CliChannel model commands', () => {
  function catalogCapabilities(
    defaultSelection: DefaultModelSelection = {
      state: 'available',
      reference: { providerId: 'relay', modelId: 'model-a' },
    },
  ): ChannelRuntimeCapabilities {
    return {
      modelCatalog: {
        getSnapshot: () => ({
          generation: 7,
          defaultSelection,
          providers: [{
            providerId: 'relay',
            displayName: 'Relay <Local>',
            models: [
              { modelId: 'model-a', displayName: 'Model A' },
              { modelId: 'model-b', displayName: 'Model B' },
              { modelId: ' model/vendor:v1?x=1\n\u0000 ', displayName: 'Opaque\nModel' },
              { modelId: '', displayName: 'Empty ID' },
            ],
          }],
        }),
      },
      abort: {
        querySessionsNeedingAbort: () => [],
        abortTurn: () => ({ aborted: false, dropped: 0 }),
      },
    };
  }

  async function startInteractive(
    defaultSelection?: DefaultModelSelection,
    capabilityOverride?: ChannelRuntimeCapabilities,
  ) {
    const existingSigIntListeners = process.listeners('SIGINT');
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const handler = vi.fn(async () => undefined);
    const channel = new CliChannel({ input, output });
    channel.bindRuntimeCapabilities(capabilityOverride ?? catalogCapabilities(defaultSelection));
    channel.onMessage(handler);
    await channel.start();
    return {
      channel,
      input,
      handler,
      captured: () => stripAnsi(Buffer.concat(chunks).toString('utf-8')),
      async close() {
        input.end();
        await channel.completion;
        await channel.stop();
        process.removeAllListeners('SIGINT');
        for (const listener of existingSigIntListeners) process.on('SIGINT', listener);
      },
    };
  }

  it('lists grouped models, marks default/override, and keeps commands out of Runtime', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/models\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('Relay <Local> (relay)'));
      expect(fixture.captured()).toContain('Model A (model-a) [default]');

      fixture.input.write('/model relay "model-b"\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('override set to relay/model-b'));
      fixture.input.write('/models\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('Model B (model-b) [override]'));
      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionKey: 'main',
        message: 'hello',
        modelReference: { providerId: 'relay', modelId: 'model-b' },
      }));
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it('selects an arbitrary opaque Model ID from JSON without mutating it', async () => {
    const modelId = ' model/vendor:v1?x=1\n\u0000 ';
    const fixture = await startInteractive();
    try {
      fixture.input.write('/models\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('Opaque\\u000aModel'));
      expect(fixture.captured()).toContain(JSON.stringify(modelId));

      fixture.input.write(`/model relay ${JSON.stringify(modelId)}\n`);
      await vi.waitFor(() => expect(fixture.captured()).toContain('override set'));
      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionKey: 'main',
        message: 'hello',
        modelReference: { providerId: 'relay', modelId },
      }));
    } finally {
      await fixture.close();
    }
  });

  it('selects an empty string Model ID through the JSON command grammar', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/model relay ""\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('override set to relay/""'));
      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionKey: 'main',
        message: 'hello',
        modelReference: { providerId: 'relay', modelId: '' },
      }));
    } finally {
      await fixture.close();
    }
  });

  it('shows unavailable default, rejects unknown selection, and clears override', async () => {
    const fixture = await startInteractive({
      state: 'unavailable',
      reference: { providerId: 'missing', modelId: 'gone' },
      reason: 'provider_unregistered',
    });
    try {
      fixture.input.write('/model\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'default: missing/gone (unavailable: provider_unregistered)',
      ));
      expect(fixture.captured()).toContain('effective: none');

      fixture.input.write('/model relay "missing"\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('is not in generation 7'));
      fixture.input.write('/model relay "model-a"\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('override set to relay/model-a'));
      fixture.input.write('/model default\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('override cleared'));
      expect(fixture.handler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('rechecks a stale override before ordinary input', async () => {
    let current = catalogCapabilities().modelCatalog.getSnapshot();
    const capabilities = catalogCapabilities();
    capabilities.modelCatalog.getSnapshot = () => current;
    const fixture = await startInteractive(undefined, capabilities);
    try {
      fixture.input.write('/model relay "model-b"\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('override set to relay/model-b'));

      current = { ...current, generation: 8, providers: [] };
      fixture.input.write('must not dispatch\n');

      await vi.waitFor(() => expect(fixture.captured()).toContain(
        '[model unavailable] relay/model-b is not in the current Catalog.',
      ));
      expect(fixture.handler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('reports local unavailability when capabilities are not bound', () => {
    const { channel, captured } = makeChannel();
    const handled = (channel as unknown as { handleModelCommand(input: string): boolean })
      .handleModelCommand('/models');
    expect(handled).toBe(true);
    expect(captured()).toContain('Runtime Model Catalog is not bound');
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

  function makeCapabilities(
    partial: Partial<TurnAbortCapability> = {},
  ): {
    capabilities: ChannelRuntimeCapabilities;
    abortTurn: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  } {
    const abortTurn = vi.fn(
      partial.abortTurn ?? (() => ({ aborted: false, dropped: 0 })),
    );
    const query = vi.fn(partial.querySessionsNeedingAbort ?? (() => []));
    return {
      capabilities: {
        modelCatalog: {
          getSnapshot: () => ({
            generation: 1,
            defaultSelection: { state: 'unset' },
            providers: [],
          }),
        },
        abort: { querySessionsNeedingAbort: query, abortTurn },
      },
      abortTurn,
      query,
    };
  }

  it('single Ctrl+C with an active turn → calls abort capability and renders "[⚠ aborted N turn(s)]"', () => {
    const { channel, captured } = makeChannel();
    const { capabilities, abortTurn, query } = makeCapabilities({
      querySessionsNeedingAbort: () => ['main'],
      abortTurn: () => ({ aborted: true, dropped: 0 }),
    });
    channel.bindRuntimeCapabilities(capabilities);

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

  it('double Ctrl+C within 1s closes CLI input without owning process exit', () => {
    const { channel, captured } = makeChannel();
    // Hooks bound but nothing to abort — makes the FIRST Ctrl+C fall into
    // the "press again to exit" branch (arms lastCtrlCAt) instead of the
    // abort path. Second Ctrl+C then trips the double-tap exit.
    channel.bindRuntimeCapabilities(makeCapabilities().capabilities);

    const exitSpy = vi.spyOn(process, 'exit');

    const internal = channel as unknown as CliChannelInternal;
    internal.handleSigInt(); // first — arms lastCtrlCAt
    expect(exitSpy).not.toHaveBeenCalled();

    expect(() => internal.handleSigInt()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(captured()).toContain('[exiting]');
  });

  it('hooks not bound (standalone CLI) → Ctrl+C renders exit hint and never crashes', () => {
    const { channel, captured } = makeChannel();

    // No capability binding — standalone behavior remains available.
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
    const { capabilities, abortTurn } = makeCapabilities({
      // querySessionsNeedingAbort returns sessions with queued msgs even
      // when there's no active turn (spec §12 note (ii)).
      querySessionsNeedingAbort: () => ['main'],
      // Runtime side: no active abort but 3 dropped messages.
      abortTurn: () => ({ aborted: false, dropped: 3 }),
    });
    channel.bindRuntimeCapabilities(capabilities);

    (channel as unknown as CliChannelInternal).handleSigInt();

    expect(abortTurn).toHaveBeenCalledWith('main');
    const out = captured();
    expect(out).toContain('dropped 3 queued message(s)');
    // Critically: no "aborted 0 turn(s)" or "aborted N turn(s)" fragment
    // when totalAborted === 0.
    expect(out).not.toMatch(/aborted \d+ turn/);
  });
});
