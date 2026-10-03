import { describe, expect, it } from 'vitest';
import { deriveInitialSessionTitle } from './title.js';

describe('deriveInitialSessionTitle', () => {
  it('normalizes the first non-empty user text block', () => {
    expect(deriveInitialSessionTitle([
      { type: 'text', text: '  \n ' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'data' },
        dimensions: { width: 1, height: 1 },
      },
      { type: 'text', text: '  hello\n\tworld  ' },
      { type: 'text', text: 'ignored' },
    ])).toBe('hello world');
  });

  it('returns undefined when no usable user text exists', () => {
    expect(deriveInitialSessionTitle(' \n\t ')).toBeUndefined();
  });

  it('truncates to 48 Unicode graphemes including the ellipsis', () => {
    const family = '👨‍👩‍👧‍👦';
    const title = deriveInitialSessionTitle(family.repeat(49));

    expect(title).toBe(family.repeat(47) + '…');
    expect(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title!)))
      .toHaveLength(48);
  });
});