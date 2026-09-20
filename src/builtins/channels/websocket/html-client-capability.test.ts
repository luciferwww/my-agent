import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('HTML attachment capability UX', () => {
  it('fails open for unknown media capability and disables explicit non-image models', async () => {
    const html = await readFile(
      join(process.cwd(), 'clients', 'html', 'chat.html'),
      'utf8',
    );

    expect(html).toContain(
      "return !Array.isArray(mediaKinds) || mediaKinds.includes('image');",
    );
    expect(html).toContain(
      ":disabled=\"!isConnected || isWaitingForReply || !selectedModelSupportsImages\"",
    );
    expect(html).toContain(
      'The selected model explicitly does not support image attachments.',
    );
  });
});
