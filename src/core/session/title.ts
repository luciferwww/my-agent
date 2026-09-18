import type { ContentBlock } from './types.js';

const MAX_TITLE_GRAPHEMES = 48;

export function deriveInitialSessionTitle(
  content: string | ContentBlock[],
): string | undefined {
  try {
    const text = typeof content === 'string'
      ? content
      : content.find((block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text' && Boolean(block.text.trim()))?.text;
    const normalized = text?.trim().replace(/\s+/gu, ' ');
    if (!normalized) return undefined;

    const graphemes = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized),
      (part) => part.segment,
    );
    if (graphemes.length <= MAX_TITLE_GRAPHEMES) return normalized;
    return graphemes.slice(0, MAX_TITLE_GRAPHEMES - 1).join('') + '…';
  } catch {
    return undefined;
  }
}