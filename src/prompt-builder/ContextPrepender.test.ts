import { describe, it, expect, vi } from 'vitest';
import { ContextPrepender } from './ContextPrepender.js';

describe('ContextPrepender', () => {
  it('returns empty array when no hooks registered', async () => {
    const prepender = new ContextPrepender();
    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual([]);
  });

  it('collects result from a single hook', async () => {
    const prepender = new ContextPrepender();
    prepender.register({
      id: 'test',
      provider: () => 'context text',
    });

    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual(['context text']);
  });

  it('skips hooks that return null', async () => {
    const prepender = new ContextPrepender();
    prepender.register({
      id: 'null-hook',
      provider: () => null,
    });

    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual([]);
  });

  it('skips hooks that return empty/whitespace string', async () => {
    const prepender = new ContextPrepender();
    prepender.register({
      id: 'empty-hook',
      provider: () => '   ',
    });

    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual([]);
  });

  it('collects from multiple hooks in registration order', async () => {
    const prepender = new ContextPrepender();
    prepender.register({ id: 'first', provider: () => 'chunk-1' });
    prepender.register({ id: 'second', provider: () => 'chunk-2' });
    prepender.register({ id: 'third', provider: () => 'chunk-3' });

    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  it('unregister removes a hook', async () => {
    const prepender = new ContextPrepender();
    prepender.register({ id: 'keep', provider: () => 'kept' });
    prepender.register({ id: 'remove', provider: () => 'removed' });
    prepender.unregister('remove');

    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual(['kept']);
  });

  it('increments turnIndex on each prepend call', async () => {
    const turnIndexes: number[] = [];
    const prepender = new ContextPrepender();
    prepender.register({
      id: 'tracker',
      provider: (_raw, meta) => {
        turnIndexes.push(meta.turnIndex);
        return null;
      },
    });

    await prepender.prepend('first');
    await prepender.prepend('second');
    await prepender.prepend('third');

    expect(turnIndexes).toEqual([0, 1, 2]);
  });

  it('passes rawInput and metadata to provider', async () => {
    const received: { rawInput: string; custom?: unknown }[] = [];
    const prepender = new ContextPrepender();
    prepender.register({
      id: 'spy',
      provider: (rawInput, meta) => {
        received.push({ rawInput, custom: meta.customField });
        return null;
      },
    });

    await prepender.prepend('hello', { customField: 'value' });

    expect(received[0]!.rawInput).toBe('hello');
    expect(received[0]!.custom).toBe('value');
  });

  it('handles async providers', async () => {
    const prepender = new ContextPrepender();
    prepender.register({
      id: 'async',
      provider: async () => {
        return 'async result';
      },
    });

    const chunks = await prepender.prepend('hello');
    expect(chunks).toEqual(['async result']);
  });
});
