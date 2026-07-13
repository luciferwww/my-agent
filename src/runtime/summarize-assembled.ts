import { Buffer } from 'node:buffer';
import type { ChatContentBlock } from '../adapters/llm/types.js';
import type { AttachmentSummary } from '../core/runner/index.js';
import { Logger } from '../platform/logger/index.js';

const log = Logger.get('summarizeAssembled');

/**
 * 把 assembled user message 拆成「广播用文本 + 附件摘要」。
 *
 * 见 channel-multi-client-user-message-spec §5.2。
 * 原始字节永远不进事件流：图片仅记录 mime + bytes。
 */
export function summarizeAssembled(
  assembled: string | ChatContentBlock[],
): { text: string; attachmentSummaries: AttachmentSummary[] } {
  if (typeof assembled === 'string') {
    return { text: assembled, attachmentSummaries: [] };
  }

  const texts: string[] = [];
  const attachmentSummaries: AttachmentSummary[] = [];

  for (const block of assembled) {
    if (block.type === 'text') {
      texts.push(block.text);
      continue;
    }

    if (block.type === 'image') {
      const source = block.source as { type: string; media_type?: string; data?: string };
      if (source.type === 'base64') {
        attachmentSummaries.push({
          type: 'image',
          mime: source.media_type,
          bytes: source.data !== undefined
            ? Buffer.byteLength(source.data, 'base64')
            : undefined,
        });
      } else {
        log.warn('image block has non-base64 source; omitting bytes', {
          sourceType: source.type,
        });
        attachmentSummaries.push({
          type: 'image',
          mime: source.media_type,
          bytes: undefined,
        });
      }
      continue;
    }

    attachmentSummaries.push({ type: 'other' });
  }

  return {
    text: texts.join('\n\n'),
    attachmentSummaries,
  };
}
