import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../llm-client/types.js';
import {
  estimateMessageTokens,
  estimatePromptTokens,
  SAFETY_MARGIN,
} from './token-estimation.js';

describe('token-estimation', () => {
  describe('estimateMessageTokens', () => {
    it('estimates plain text message', () => {
      const msg: ChatMessage = { role: 'user', content: 'Hello world' };
      const tokens = estimateMessageTokens(msg);
      // "Hello world" = 11 chars → 11/4 = 2.75 → ceil = 3, + 4 overhead = 7
      expect(tokens).toBe(7);
    });

    it('estimates empty content', () => {
      const msg: ChatMessage = { role: 'user', content: '' };
      const tokens = estimateMessageTokens(msg);
      // 0 chars → 0 + 4 overhead = 4
      expect(tokens).toBe(4);
    });

    it('estimates text content block', () => {
      const msg: ChatMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'a'.repeat(400) }],
      };
      const tokens = estimateMessageTokens(msg);
      // 400 chars → 100 + 4 overhead = 104
      expect(tokens).toBe(104);
    });

    it('estimates tool_use block', () => {
      const msg: ChatMessage = {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'read_file',
          input: { path: '/tmp/test.txt' },
        }],
      };
      const tokens = estimateMessageTokens(msg);
      // name "read_file" (9 chars → 3) + JSON.stringify(input) (~25 chars → 7) + 4 overhead
      expect(tokens).toBeGreaterThan(4);
    });

    it('estimates tool_result block', () => {
      const content = 'a'.repeat(1000);
      const msg: ChatMessage = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }],
      };
      const tokens = estimateMessageTokens(msg);
      // 1000 chars → 250 + 4 overhead = 254
      expect(tokens).toBe(254);
    });

    it('estimates image block with fixed value', () => {
      const msg: ChatMessage = {
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        }],
      };
      const tokens = estimateMessageTokens(msg);
      // 2000 (image) + 4 overhead = 2004
      expect(tokens).toBe(2004);
    });

    it('estimates message with mixed blocks', () => {
      const msg: ChatMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a'.repeat(100) },
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
        ],
      };
      const tokens = estimateMessageTokens(msg);
      // text: 25, tool_use: >0, + 4 overhead
      expect(tokens).toBeGreaterThan(29);
    });
  });

  describe('estimatePromptTokens', () => {
    it('returns 0 for empty input', () => {
      const tokens = estimatePromptTokens({ messages: [] });
      expect(tokens).toBe(0);
    });

    it('includes system prompt in estimate', () => {
      const withoutSystem = estimatePromptTokens({ messages: [] });
      const withSystem = estimatePromptTokens({
        messages: [],
        systemPrompt: 'a'.repeat(400),
      });
      expect(withSystem).toBeGreaterThan(withoutSystem);
    });

    it('applies safety margin', () => {
      const msg: ChatMessage = { role: 'user', content: 'a'.repeat(400) };
      const tokens = estimatePromptTokens({ messages: [msg] });
      const rawEstimate = estimateMessageTokens(msg);
      // tokens should be ceil(rawEstimate * SAFETY_MARGIN)
      expect(tokens).toBe(Math.ceil(rawEstimate * SAFETY_MARGIN));
    });

    it('sums multiple messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
      ];
      const tokens = estimatePromptTokens({ messages });
      // 3 messages × (25 + 4 overhead) = 87 raw → ceil(87 * 1.2) = 105
      expect(tokens).toBe(105);
    });
  });
});
