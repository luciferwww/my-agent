import { describe, expect, it } from 'vitest';
import { deriveSubagentRequestRequirements } from './request-requirements.js';

describe('deriveSubagentRequestRequirements', () => {
  it('derives the Slice 2 string/no-tools baseline from the actual request', () => {
    expect(deriveSubagentRequestRequirements({ message: 'child prompt' })).toEqual({
      tools: false,
      mediaKinds: [],
    });
  });

  it('derives tool and media requirements from assembled input without duplicates', () => {
    expect(deriveSubagentRequestRequirements({
      message: [
        { type: 'text', text: 'inspect' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'x' },
          dimensions: { width: 1, height: 1 },
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'y' },
          dimensions: { width: 1, height: 1 },
        },
      ],
      tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
    })).toEqual({ tools: true, mediaKinds: ['image'] });
  });
});
