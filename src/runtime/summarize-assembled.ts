import { Buffer } from 'node:buffer';
import type { ChatContentBlock } from '../core/model-invocation/index.js';
import type { AttachmentSummary } from '../core/runner/index.js';
import { Logger } from '../platform/logger/index.js';

const log = Logger.get('summarizeAssembled');

/**
 * Split an assembled user message into broadcast text and attachment summaries.
 *
 * See channel-multi-client-user-message-spec §5.2.
 * Raw bytes never enter the event stream; images include only MIME type and byte count.
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
