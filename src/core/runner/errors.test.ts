import { describe, it, expect } from 'vitest';
import { ContextOverflowError, isContextOverflowError } from './errors.js';

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

describe('isContextOverflowError', () => {
  // 覆盖所有 API 提供商的关键词

  it('matches request_too_large (Anthropic)', () => {
    expect(isContextOverflowError(new Error('request_too_large: prompt exceeds limit'))).toBe(true);
  });

  it('matches context_length_exceeded (OpenAI / compatible)', () => {
    expect(isContextOverflowError(new Error('context_length_exceeded for this model'))).toBe(true);
  });

  it('matches prompt is too long', () => {
    expect(isContextOverflowError(new Error('The prompt is too long to process'))).toBe(true);
  });

  it('matches maximum context length', () => {
    expect(isContextOverflowError(new Error("This model's maximum context length is 200000 tokens"))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isContextOverflowError(new Error('Request_Too_Large'))).toBe(true);
    expect(isContextOverflowError(new Error('CONTEXT_LENGTH_EXCEEDED'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isContextOverflowError(new Error('network timeout'))).toBe(false);
    expect(isContextOverflowError(new Error('invalid api key'))).toBe(false);
    expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(false);
    expect(isContextOverflowError(new Error(''))).toBe(false);
  });
});
