export const SUPPORTED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export const ATTACHMENT_INLINE_THRESHOLD_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_RAW_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

export interface AttachmentSummary {
  readonly sizeBytes: number;
}

export function base64DecodedSize(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

export function validateAttachmentSelection(
  existing: readonly AttachmentSummary[],
  incoming: readonly File[],
): string[] {
  const errors: string[] = [];
  let runningTotal = existing.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  let runningCount = existing.length;

  for (const file of incoming) {
    if (!SUPPORTED_IMAGE_MIME.has(file.type)) {
      errors.push(
        `${file.name || 'Unnamed file'}: type ${file.type || 'unknown'} is not supported`,
      );
    }
    if (file.size > ATTACHMENT_RAW_MAX_BYTES) {
      errors.push(
        `${file.name}: exceeds the ${ATTACHMENT_RAW_MAX_BYTES / 1024 / 1024} MB per-image limit`,
      );
    }
    if (runningCount + 1 > MAX_ATTACHMENTS_PER_MESSAGE) {
      errors.push(`Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} images`);
      break;
    }
    if (runningTotal + file.size > ATTACHMENT_TOTAL_MAX_BYTES) {
      errors.push(`Total size exceeds ${ATTACHMENT_TOTAL_MAX_BYTES / 1024 / 1024} MB`);
      break;
    }
    runningTotal += file.size;
    runningCount += 1;
  }
  return errors;
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const separatorIndex = value.indexOf(',');
      resolve(separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}
