import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../core/runner/types.js';
import { CliChannel } from './CliChannel.js';

// Strip ANSI escape sequences so assertions don't fight color codes.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function makeChannel(): { channel: CliChannel; captured: () => string } {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (c: Buffer) => chunks.push(c));
  const channel = new CliChannel({
    input: new PassThrough(),
    output: output as unknown as NodeJS.WritableStream,
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
