import { describe, it, expect } from 'vitest';
import { UserPromptBuilder } from './UserPromptBuilder.js';

describe('UserPromptBuilder', () => {
  it('returns raw text when no hooks', async () => {
    const builder = new UserPromptBuilder();
    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe('hello');
  });

  it('prepends hook chunks before raw text', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({
        id: 'ctx',
        provider: () => 'context info',
      });

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe('context info\n\nhello');
  });

  it('prepends multiple hooks in registration order', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({ id: 'first', provider: () => 'chunk-1' })
      .useContextHook({ id: 'second', provider: () => 'chunk-2' });

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe('chunk-1\n\nchunk-2\n\nhello');
  });

  it('skips null hooks', async () => {
    const builder = new UserPromptBuilder()
      .useContextHook({ id: 'null', provider: () => null })
      .useContextHook({ id: 'valid', provider: () => 'context' });

    const result = await builder.build({ text: 'hello' });
    expect(result.text).toBe('context\n\nhello');
  });

  it('passes attachments through without embedding in text', async () => {
    const builder = new UserPromptBuilder();
    const attachments = [
      { type: 'image' as const, data: 'base64...', mimeType: 'image/png' },
    ];

    const result = await builder.build({ text: 'look at this', attachments });
    expect(result.text).toBe('look at this');
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
    expect(result.text).toBe('kept\n\nhello');
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
});
