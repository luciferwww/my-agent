import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { UserPromptBuilder } from './UserPromptBuilder.js';

describe('UserPromptBuilder', () => {
  const timestamp = '<turn_start>2026-10-16T09:30:00.000Z</turn_start>';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T09:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prepends the timestamp before raw text when no hooks', async () => {
    const builder = new UserPromptBuilder();
    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe(`${timestamp}\n\nhello`);
  });

  it('prepends hook chunks before raw text', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({
        id: 'ctx',
        provider: () => 'context info',
      });

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe(`${timestamp}\n\ncontext info\n\nhello`);
  });

  it('prepends multiple hooks in registration order', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({ id: 'first', provider: () => 'chunk-1' })
      .useContextHook({ id: 'second', provider: () => 'chunk-2' });

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe(`${timestamp}\n\nchunk-1\n\nchunk-2\n\nhello`);
  });

  it('skips null hooks', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({ id: 'null', provider: () => null })
      .useContextHook({ id: 'valid', provider: () => 'context' });

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe(`${timestamp}\n\ncontext\n\nhello`);
  });

  it('passes attachments through without embedding in text', async () => {
    const builder = new UserPromptBuilder();
    const attachments = [
      { type: 'image' as const, data: 'base64...', mimeType: 'image/png' },
    ];

    const result = await builder.build({ text: 'look at this', attachments });
    expect(result.text).toBe(`${timestamp}\n\nlook at this`);
    expect(result.attachments).toEqual(attachments);
  });

  it('returns empty attachments array when none provided', async () => {
    const builder = new UserPromptBuilder();
    const result = await builder.build({ text: 'hello' });
    expect(result.attachments).toEqual([]);
  });

  it('includes debug info', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({ id: 'ctx', provider: () => 'chunk' });

    const result = await builder.build({ text: 'hello' });
    expect(result._debug).toEqual({
      rawInput: 'hello',
      prependedChunks: ['chunk'],
    });
  });

  it('removeContextHook removes a hook', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({ id: 'keep', provider: () => 'kept' })
      .useContextHook({ id: 'remove', provider: () => 'removed' })
      .removeContextHook('remove');

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe(`${timestamp}\n\nkept\n\nhello`);
  });

  it('useContextHook returns this for chaining', () => {
    const builder = new UserPromptBuilder();
    const returned = builder.useContextHook({ id: 'a', provider: () => null });
    expect(returned).toBe(builder);
  });

  it('removeContextHook returns this for chaining', () => {
    const builder = new UserPromptBuilder();
    const returned = builder.removeContextHook('nonexistent');
    expect(returned).toBe(builder);
  });

  it('captures time before async hooks and does not change earlier prompts', async () => {
    const builder = new UserPromptBuilder().useContextHook({
      id: 'advance-time',
      provider: async () => {
        vi.setSystemTime(new Date('2026-10-16T09:31:00.000Z'));
        return 'context';
      },
    });
    const first = await builder.build({ text: 'first' });
    const second = await builder.build({ text: 'second' });
    expect(first.text).toBe(`${timestamp}\n\ncontext\n\nfirst`);
    expect(second.text).toBe(
      '<turn_start>2026-10-16T09:31:00.000Z</turn_start>\n\ncontext\n\nsecond',
    );
  });
});
