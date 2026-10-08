import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentEvent } from '../../../core/runner/types.js';
import type {
  ChannelRuntimeCapabilities,
  DefaultModelSelection,
  TurnAbortCapability,
} from '../../../core/channel/index.js';
import { CliChannel } from './CliChannel.js';

// Strip ANSI escape sequences so assertions don't fight color codes.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CLI_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const MANUAL_PERMISSION = {
  sessionId: CLI_SESSION_ID,
  mode: 'manual' as const,
  changedAt: 1,
};
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
      sessionId: 'main',
      messageId: 'msg-1',
      content: 'hello there',
      originClientId: 'client-prefix-suffix',
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
      sessionId: 'main',
      messageId: 'msg-2',
      content: 'from cli',
      originClientId: null,
      timestamp: Date.now(),
    });
    expect(captured()).toBe('');
  });

  it('single attachment: appends (+1 attachment) hint', () => {
    const { channel, captured } = makeChannel();
    channel.send({
      type: 'user_message',
      sessionId: 'main',
      messageId: 'msg-3',
      content: 'look',
      attachmentSummaries: [{ type: 'image', mime: 'image/png', bytes: 1024 }],
      originClientId: 'abcdef123',
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
      sessionId: 'main',
      messageId: 'msg-4',
      content: 'many',
      attachmentSummaries: [
        { type: 'image' },
        { type: 'image' },
        { type: 'other' },
      ],
      originClientId: 'abcdef123',
      timestamp: Date.now(),
    });
    expect(captured()).toContain('(+3 attachments)');
  });

  it('breaks streaming text with a newline before rendering user_message', () => {
    const { channel, captured } = makeChannel();
    channel.send({ type: 'text_delta', sessionId: 'main', turnId: 't1', text: 'streaming...' });
    channel.send({
      type: 'user_message',
      sessionId: 'main',
      messageId: 'msg-5',
      content: 'inject',
      originClientId: 'abcdef123',
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
      sessionId: 'main',
      messageId: 'msg-6',
      content: 'x',
      attachmentSummaries: [
        { type: 'image', mime: 'image/png', bytes: 999999, name: 'secret.png' },
      ],
      originClientId: 'abcdef123',
      timestamp: Date.now(),
    });
    const out = captured();
    expect(out).not.toContain('secret.png');
    expect(out).not.toContain('999999');
    expect(out).not.toContain('image/png');
  });
});

describe('CliChannel Thinking rendering', () => {
  it('renders Thinking separately and restores normal text output', () => {
    const { channel, captured } = makeChannel();
    const base = { sessionId: 'main', turnId: 't1', requestId: 'r1' };

    channel.send({ ...base, type: 'thinking_start', thinkingId: 'thinking-1' });
    channel.send({
      ...base,
      type: 'thinking_delta',
      thinkingId: 'thinking-1',
      text: 'considering',
    });
    channel.send({
      ...base,
      type: 'thinking_end',
      thinkingId: 'thinking-1',
      text: 'considering',
      status: 'complete',
    });
    channel.send({ ...base, type: 'text_delta', text: 'answer' });

    expect(captured()).toBe('[thinking]\nconsidering\nanswer');
  });
});

describe('CliChannel run completion rendering', () => {
  it('renders a generic notice when the configured Model-call limit is reached', () => {
    const { channel, captured } = makeChannel();

    channel.send({
      type: 'run_end',
      sessionId: CLI_SESSION_ID,
      turnId: 'turn-limit',
      requestId: 'request-limit',
      result: {
        text: 'partial',
        content: [{ type: 'text', text: 'partial' }],
        stopReason: 'max_llm_calls',
        usage: { inputTokens: 10, outputTokens: 5 },
        toolRounds: 2,
      },
    });

    expect(captured()).toContain('[configured model call limit reached]');
  });

  it('does not add the limit notice for normal completion', () => {
    const { channel, captured } = makeChannel();

    channel.send({
      type: 'run_end',
      sessionId: CLI_SESSION_ID,
      turnId: 'turn-complete',
      requestId: 'request-complete',
      result: {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        toolRounds: 0,
      },
    });

    expect(captured()).not.toContain('model call limit');
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
    createSession: ChannelRuntimeCapabilities['sessions']['createSession'] = async () => ({
      sessionId: CLI_SESSION_ID,
      permission: MANUAL_PERMISSION,
    }),
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
              {
                modelId: 'model-a',
                displayName: 'Model A',
                capabilities: {
                  reasoning: {
                    thinking: ['on', 'off'],
                    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                  },
                },
              },
              {
                modelId: 'model-b',
                displayName: 'Model B',
                capabilities: {
                  reasoning: {
                    thinking: ['off'],
                    efforts: ['none', 'low'],
                  },
                },
              },
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
      sessions: {
        createSession,
        listSessions: async () => [],
        getSession: async (sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1 }),
        getHistory: async ({ sessionId }) => ({
          sessionId, items: [], nextCursor: null, hasMore: false,
        }),
        renameSession: async (sessionId, title) => ({
          sessionId,
          createdAt: 1,
          updatedAt: 1,
          ...(title === null ? {} : { title }),
        }),
        archiveSession: async (sessionId) => ({
          sessionId,
          createdAt: 1,
          updatedAt: 1,
          archivedAt: 1,
        }),
        unarchiveSession: async (sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1 }),
        deleteSession: async () => undefined,
        forkSession: async () => ({
          sessionId: CLI_SESSION_ID,
          createdAt: 1,
          updatedAt: 1,
        }),
        getPermissionMode: () => MANUAL_PERMISSION,
        setPermissionMode: ({ sessionId, mode, originClientId }) => ({
          sessionId,
          mode,
          changedAt: 2,
          ...(originClientId ? { changedByClientId: originClientId } : {}),
        }),
        onPermissionModeChanged: () => () => undefined,
      },
    };
  }

  async function startInteractive(
    defaultSelection?: DefaultModelSelection,
    capabilityOverride?: ChannelRuntimeCapabilities,
    approval = false,
  ) {
    const existingSigIntListeners = process.listeners('SIGINT');
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const handler = vi.fn(async () => undefined);
    const channel = new CliChannel({ input, output, approval });
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
        sessionId: CLI_SESSION_ID,
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
        sessionId: CLI_SESSION_ID,
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
        sessionId: CLI_SESSION_ID,
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
        'Runtime default (missing/gone, unavailable) [current]',
      ));
      fixture.input.write('\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[model] unchanged.'));

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

  it('reports local unavailability when capabilities are not bound', async () => {
    const { channel, captured } = makeChannel();
    const handled = (channel as unknown as {
      handleModelCommand(input: string): Promise<boolean>;
    }).handleModelCommand('/models');
    await expect(handled).resolves.toBe(true);
    expect(captured()).toContain('Runtime Model Catalog is not bound');
  });

  it('creates one Session only when the first ordinary message is sent', async () => {
    const createSession = vi.fn(async () => ({
      sessionId: CLI_SESSION_ID,
      permission: MANUAL_PERMISSION,
    }));
    const fixture = await startInteractive(undefined, catalogCapabilities(undefined, createSession));
    try {
      fixture.input.write('/models\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('Relay <Local> (relay)'));
      expect(createSession).not.toHaveBeenCalled();

      fixture.input.write('first\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'first',
      }));
      fixture.input.write('second\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'second',
      }));
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it('supports create, first send, list/get/select, rename, and delete', async () => {
    let entry = {
      sessionId: CLI_SESSION_ID,
      createdAt: 1,
      updatedAt: 2,
      title: 'First message',
    };
    const createSession = vi.fn(async () => ({
      sessionId: CLI_SESSION_ID,
      permission: MANUAL_PERMISSION,
    }));
    const listSessions = vi.fn(async () => [entry]);
    const getSession = vi.fn(async () => entry);
    const renameSession = vi.fn(async (_sessionId: string, title: string | null) => {
      entry = {
        ...entry,
        updatedAt: 3,
        title: title ?? '',
      };
      return entry;
    });
    const deleteSession = vi.fn(async () => undefined);
    const baseCapabilities = catalogCapabilities(undefined, createSession);
    const getHistory = vi.fn(baseCapabilities.sessions.getHistory);
    const runtimeCapabilities: ChannelRuntimeCapabilities = {
      ...baseCapabilities,
      sessions: {
        ...baseCapabilities.sessions,
        listSessions,
        getSession,
        getHistory,
        renameSession,
        deleteSession,
      },
    };
    const fixture = await startInteractive(undefined, runtimeCapabilities);
    try {
      fixture.input.write('First message\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'First message',
      }));

      fixture.input.write('/sessions\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        `${CLI_SESSION_ID} [current] First message`,
      ));
      fixture.input.write('/session new\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        '[session] new; the first message will create it.',
      ));
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(getHistory).not.toHaveBeenCalled();

      fixture.input.write(`/session use ${CLI_SESSION_ID}\n`);
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        `[session] current ${CLI_SESSION_ID} First message.`,
      ));
      fixture.input.write('/session\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select session]'));
      fixture.input.write('\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[session] unchanged.'));
      fixture.input.write('/session rename "Renamed"\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        `[session] renamed ${CLI_SESSION_ID} Renamed.`,
      ));
      fixture.input.write('/session delete\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        `[session] deleted ${CLI_SESSION_ID}.`,
      ));

      expect(listSessions).toHaveBeenCalledTimes(2);
      expect(getHistory).toHaveBeenCalledTimes(1);
      expect(renameSession).toHaveBeenCalledWith(CLI_SESSION_ID, 'Renamed');
      expect(deleteSession).toHaveBeenCalledWith(CLI_SESSION_ID);
      expect(fixture.handler).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it('shows permission mode, strongly confirms Allow All, and switches back to manual', async () => {
    let mode: 'manual' | 'allow_all' = 'manual';
    const baseCapabilities = catalogCapabilities();
    const setPermissionMode = vi.fn(({ sessionId, mode: nextMode }: {
      sessionId: string;
      mode: 'manual' | 'allow_all';
    }) => {
      mode = nextMode;
      return { sessionId, mode, changedAt: 2 };
    });
    const fixture = await startInteractive(undefined, {
      ...baseCapabilities,
      sessions: {
        ...baseCapabilities.sessions,
        getPermissionMode: (sessionId) => ({ sessionId, mode, changedAt: 1 }),
        setPermissionMode,
      },
    });
    try {
      fixture.input.write('create me\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledTimes(1));

      fixture.input.write('/permission\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select permission]'));
      expect(fixture.captured()).toContain('manual (individual approvals required) [current]');
      fixture.input.write('\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[permission] unchanged.'));

      fixture.input.write('/permission allow_all\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'every non-denied tool without asking',
      ));
      expect(setPermissionMode).not.toHaveBeenCalled();
      fixture.input.write('ALLOW ALL\n');
      await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        mode: 'allow_all',
      }));
      expect(fixture.captured()).toContain('Allow all for this Session');

      fixture.input.write('/permission manual\n');
      await vi.waitFor(() => expect(setPermissionMode).toHaveBeenLastCalledWith({
        sessionId: CLI_SESSION_ID,
        mode: 'manual',
      }));
      expect(fixture.captured()).toContain('individual approvals required');
    } finally {
      await fixture.close();
    }
  });

  it('renders grouped help without dispatching a message', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/help\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[help]'));
      expect(fixture.captured()).toContain('Model');
      expect(fixture.captured()).toContain('Reasoning');
      expect(fixture.captured()).toContain('Sessions');
      expect(fixture.captured()).toContain('Permissions');
      expect(fixture.captured()).toContain('Ctrl+C');
      expect(fixture.handler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('supports numbered Model, Thinking, and effort selectors', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/model\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select model]'));
      fixture.input.write('2\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'override set to relay/model-a',
      ));

      fixture.input.write('/thinking\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select thinking]'));
      fixture.input.write('2\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[thinking] on'));

      fixture.input.write('/effort\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select effort]'));
      fixture.input.write('6\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[effort] high'));

      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'hello',
        modelReference: { providerId: 'relay', modelId: 'model-a' },
        reasoning: { thinking: 'on', effort: 'high' },
      }));
    } finally {
      await fixture.close();
    }
  });

  it('supports direct reasoning commands and reports combined status', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/thinking off\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[thinking] off'));
      fixture.input.write('/effort none\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[effort] none'));
      fixture.input.write('/reasoning\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[reasoning]'));
      expect(fixture.captured()).toContain('Model: relay/model-a');
      expect(fixture.captured()).toContain('Thinking: off');
      expect(fixture.captured()).toContain('Effort: none');

      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'hello',
        reasoning: { thinking: 'off', effort: 'none' },
      }));
    } finally {
      await fixture.close();
    }
  });

  it('rejects invalid and unsupported reasoning selections without mutation', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/effort none\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[effort] none'));
      fixture.input.write('/thinking on\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'thinking=on cannot be combined with effort=none',
      ));

      fixture.input.write('/model relay "model-b"\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'override set to relay/model-b',
      ));
      fixture.input.write('/thinking on\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'on is not supported by the effective Model',
      ));

      fixture.input.write('/reasoning\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('Model: relay/model-b'));
      expect(fixture.captured()).toContain('Thinking: default');
      expect(fixture.captured()).toContain('Effort: none');
      expect(fixture.handler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('reconciles stale reasoning selections before dispatch', async () => {
    const capabilities = catalogCapabilities();
    let snapshot = capabilities.modelCatalog.getSnapshot();
    capabilities.modelCatalog.getSnapshot = () => snapshot;
    const fixture = await startInteractive(undefined, capabilities);
    try {
      fixture.input.write('/thinking on\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[thinking] on'));
      fixture.input.write('/effort high\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[effort] high'));

      snapshot = {
        ...snapshot,
        generation: 8,
        providers: snapshot.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            capabilities: undefined,
          })),
        })),
      };
      fixture.input.write('after catalog change\n');

      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'after catalog change',
      }));
      expect(fixture.captured()).toContain('thinking reset from on to default');
      expect(fixture.captured()).toContain('effort reset from high to default');
    } finally {
      await fixture.close();
    }
  });

  it('cancels or rejects numbered selection without changing the Model', async () => {
    const fixture = await startInteractive();
    try {
      fixture.input.write('/model\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select model]'));
      fixture.input.write('\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[model] unchanged.'));

      fixture.input.write('/model\n');
      await vi.waitFor(() => {
        const matches = fixture.captured().match(/\[select model\]/g) ?? [];
        expect(matches).toHaveLength(2);
      });
      fixture.input.write('99\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        '[model error] Selection is out of range.',
      ));

      fixture.input.write('/model\n');
      await vi.waitFor(() => {
        const matches = fixture.captured().match(/\[select model\]/g) ?? [];
        expect(matches).toHaveLength(3);
      });
      fixture.input.write('not-a-number\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        '[model error] Selection must be a listed number.',
      ));

      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'hello',
      }));
    } finally {
      await fixture.close();
    }
  });

  it('lets an Approval preempt a selector and resumes ordinary input afterward', async () => {
    const fixture = await startInteractive(undefined, undefined, true);
    const responseHandler = vi.fn();
    fixture.channel.interaction?.onInteractionResponse(responseHandler);
    try {
      fixture.input.write('/model\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select model]'));

      expect(fixture.channel.interaction?.sendInteractionRequest({
        id: 'approval-selector',
        kind: 'approval',
        callId: 'call-selector',
        toolName: 'write_file',
        input: { path: 'example.txt' },
        sessionId: CLI_SESSION_ID,
        turnId: 'turn-selector',
      })).toEqual({ status: 'accepted' });
      await vi.waitFor(() => expect(fixture.captured()).toContain('approve? (y/n)>'));
      fixture.input.write('y\n');

      await vi.waitFor(() => expect(responseHandler).toHaveBeenCalledWith({
        id: 'approval-selector',
        kind: 'approval',
        outcome: 'submitted',
        decision: 'allow',
      }));
      fixture.input.write('hello\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'hello',
      }));
      expect(fixture.captured()).not.toContain('[error]');
    } finally {
      await fixture.close();
    }
  });

  it('selects a Session from the picker and renders safe bounded recent history', async () => {
    const baseCapabilities = catalogCapabilities();
    const getHistory = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      items: [
        {
          entryId: 'entry-1',
          turnId: 'turn-1',
          timestamp: '2026-10-08T00:00:00.000Z',
          role: 'user' as const,
          content: 'first user message',
        },
        {
          entryId: 'entry-2',
          turnId: 'turn-1',
          timestamp: '2026-10-08T00:00:01.000Z',
          role: 'assistant' as const,
          content: [
            { type: 'text' as const, text: 'assistant answer' },
            {
              type: 'thinking' as const,
              id: 'thinking-1',
              text: 'private reasoning',
              status: 'complete' as const,
            },
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: 'image/png',
                data: 'SECRET_BASE64',
              },
              dimensions: { width: 640, height: 480 },
            },
          ],
        },
      ],
      nextCursor: 'entry-1',
      hasMore: true,
    }));
    const fixture = await startInteractive(undefined, {
      ...baseCapabilities,
      sessions: {
        ...baseCapabilities.sessions,
        listSessions: async () => [{
          sessionId: CLI_SESSION_ID,
          createdAt: 1,
          updatedAt: 2,
          title: 'Existing',
        }],
        getSession: async (sessionId) => ({
          sessionId,
          createdAt: 1,
          updatedAt: 2,
          title: 'Existing',
        }),
        getHistory,
      },
    });
    try {
      fixture.input.write('/session\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[select session]'));
      fixture.input.write('2\n');
      await vi.waitFor(() => expect(fixture.captured()).toContain('[Recent session history]'));

      const output = fixture.captured();
      expect(getHistory).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        limit: 20,
      });
      expect(output.indexOf('first user message')).toBeLessThan(
        output.indexOf('assistant answer'),
      );
      expect(output).toContain('[Earlier session history not shown]');
      expect(output).toContain('[thinking: complete] private reasoning');
      expect(output).toContain('[image: image/png 640x480]');
      expect(output).not.toContain('SECRET_BASE64');
      expect(fixture.handler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('bounds history output and preserves the newest records', async () => {
    const baseCapabilities = catalogCapabilities();
    const items = Array.from({ length: 20 }, (_, index) => ({
      entryId: `entry-${index}`,
      turnId: `turn-${index}`,
      timestamp: '2026-10-08T00:00:00.000Z',
      role: 'assistant' as const,
      content: Array.from(
        { length: 20 },
        (_line, line) => `record-${index}-line-${line}`,
      ).join('\n'),
    }));
    const fixture = await startInteractive(undefined, {
      ...baseCapabilities,
      sessions: {
        ...baseCapabilities.sessions,
        getHistory: async ({ sessionId }) => ({
          sessionId,
          items,
          nextCursor: null,
          hasMore: false,
        }),
      },
    });
    try {
      fixture.input.write(`/session use ${CLI_SESSION_ID}\n`);
      await vi.waitFor(() => expect(fixture.captured()).toContain('record-19-line-19'));
      const output = fixture.captured();
      expect(output).toContain('[Earlier session history not shown]');
      expect(output).toContain('record-19-line-0');
      expect(output).not.toContain('record-0-line-0');
    } finally {
      await fixture.close();
    }
  });

  it('keeps a selected Session active when recent history cannot be displayed', async () => {
    const baseCapabilities = catalogCapabilities();
    const fixture = await startInteractive(undefined, {
      ...baseCapabilities,
      sessions: {
        ...baseCapabilities.sessions,
        getHistory: async () => {
          throw new Error('history offline');
        },
      },
    });
    try {
      fixture.input.write(`/session use ${CLI_SESSION_ID}\n`);
      await vi.waitFor(() => expect(fixture.captured()).toContain(
        'Unable to display recent history: history offline',
      ));
      fixture.input.write('continue here\n');
      await vi.waitFor(() => expect(fixture.handler).toHaveBeenCalledWith({
        sessionId: CLI_SESSION_ID,
        message: 'continue here',
      }));
    } finally {
      await fixture.close();
    }
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
      callId: 'call-1',
      toolName: 'write_file',
      input: {},
      sessionId: 'main',
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
  // Invoke the private handler through a test bridge instead of triggering
  // Vitest's process-wide SIGINT listeners. This covers only the behavior matrix.
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
        sessions: {
          createSession: async () => ({
            sessionId: CLI_SESSION_ID,
            permission: MANUAL_PERMISSION,
          }),
          listSessions: async () => [],
          getSession: async (sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1 }),
          getHistory: async ({ sessionId }) => ({
            sessionId, items: [], nextCursor: null, hasMore: false,
          }),
          renameSession: async (sessionId, title) => ({
            sessionId,
            createdAt: 1,
            updatedAt: 1,
            ...(title === null ? {} : { title }),
          }),
          archiveSession: async (sessionId) => ({
            sessionId,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: 1,
          }),
          unarchiveSession: async (sessionId) => ({ sessionId, createdAt: 1, updatedAt: 1 }),
          deleteSession: async () => undefined,
          forkSession: async () => ({
            sessionId: CLI_SESSION_ID,
            createdAt: 1,
            updatedAt: 1,
          }),
          getPermissionMode: () => MANUAL_PERMISSION,
          setPermissionMode: ({ sessionId, mode }) => ({ sessionId, mode, changedAt: 2 }),
          onPermissionModeChanged: () => () => undefined,
        },
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
