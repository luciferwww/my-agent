import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { ChatContentBlock } from '../core/model-invocation/index.js';
import { summarizeAssembled } from './summarize-assembled.js';

describe('summarizeAssembled', () => {
  it('pure string input yields empty attachmentSummaries', () => {
    const { text, attachmentSummaries } = summarizeAssembled('hello world');
    expect(text).toBe('hello world');
    expect(attachmentSummaries).toEqual([]);
  });

  it('joins multiple text blocks with double newline', () => {
    const blocks: ChatContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    const { text, attachmentSummaries } = summarizeAssembled(blocks);
    expect(text).toBe('first\n\nsecond');
    expect(attachmentSummaries).toEqual([]);
  });

  it('image block emits summary with mime + bytes and never leaks raw base64 data', () => {
    const rawData = 'YWFhYWFhYWFhYWFh'; // "aaaaaaaaaaaa" base64
    const expectedBytes = Buffer.byteLength(rawData, 'base64');
    const blocks: ChatContentBlock[] = [
      { type: 'text', text: 'see image' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: rawData },
        dimensions: { width: 10, height: 10 },
      },
    ];

    const result = summarizeAssembled(blocks);

    expect(result.text).toBe('see image');
    expect(result.attachmentSummaries).toHaveLength(1);
    expect(result.attachmentSummaries[0]).toEqual({
      type: 'image',
      mime: 'image/png',
      bytes: expectedBytes,
    });
    // raw base64 must not appear in any serialized field
    expect(JSON.stringify(result)).not.toContain(rawData);
  });

  it('R2: non-base64 image source omits bytes (not misreported from URL length)', () => {
    // Unsafe cast to construct a future variant not modelled in ChatContentBlock
    const blocks = [
      {
        type: 'image',
        source: {
          type: 'url',
          media_type: 'image/jpeg',
          url: 'https://example.com/very/long/url/that/is/many/chars.jpg',
        },
      },
    ] as unknown as ChatContentBlock[];

    const { text, attachmentSummaries } = summarizeAssembled(blocks);

    expect(text).toBe('');
    expect(attachmentSummaries).toHaveLength(1);
    expect(attachmentSummaries[0]).toEqual({
      type: 'image',
      mime: 'image/jpeg',
      bytes: undefined,
    });
    // must not leak the url field
    expect(JSON.stringify(attachmentSummaries[0])).not.toContain('example.com');
  });

  it('image block without data field: bytes undefined, no throw', () => {
    const blocks = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/gif' },
      },
    ] as unknown as ChatContentBlock[];

    const { attachmentSummaries } = summarizeAssembled(blocks);
    expect(attachmentSummaries).toHaveLength(1);
    expect(attachmentSummaries[0]).toEqual({
      type: 'image',
      mime: 'image/gif',
      bytes: undefined,
    });
  });

  it('unknown block type falls into other bucket', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'video', source: { data: 'xyz' } },
    ] as unknown as ChatContentBlock[];

    const { text, attachmentSummaries } = summarizeAssembled(blocks);
    expect(text).toBe('hi');
    expect(attachmentSummaries).toEqual([{ type: 'other' }]);
  });

  it('empty array input: empty text, empty summaries', () => {
    const { text, attachmentSummaries } = summarizeAssembled([]);
    expect(text).toBe('');
    expect(attachmentSummaries).toEqual([]);
  });

  it('pure-attachment array (no text block): empty text + non-empty summaries', () => {
    const blocks: ChatContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
        dimensions: { width: 1, height: 1 },
      },
    ];
    const { text, attachmentSummaries } = summarizeAssembled(blocks);
    expect(text).toBe('');
    expect(attachmentSummaries).toHaveLength(1);
  });
});
