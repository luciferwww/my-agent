import { describe, it, expect } from 'vitest';
import { ContextOverflowError } from './errors.js';

describe('ContextOverflowError', () => {
  it('is an instance of Error', () => {
    const err = new ContextOverflowError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ContextOverflowError);
  });

  it('preserves the message', () => {
    const err = new ContextOverflowError('context too large');
    expect(err.message).toBe('context too large');
  });

  it('has name ContextOverflowError', () => {
    const err = new ContextOverflowError('test');
    expect(err.name).toBe('ContextOverflowError');
  });
});
