import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  errorMentionsReplay,
  opaqueCount,
  replayVariants,
  runLive,
  summarize,
} from './thinking-compatibility.live-spike.js';

describe('Thinking compatibility experiment controls (not upstream compatibility proof)', () => {
  it.each(['chat', 'responses'] as const)('%s mutates only opaque while retaining identities and order', protocol => {
    const key = protocol === 'chat' ? 'reasoning_opaque' : 'encrypted_content';
    const item = protocol === 'chat'
      ? { role: 'assistant', reasoning_text: 'Synthetic display text', [key]: 'ABCD1234', tool_calls: [{ id: 'call-1' }] }
      : { type: 'reasoning', id: 'reason-1', summary: [], [key]: 'ABCD1234' };
    const history = [item, { type: 'function_call_output', call_id: 'call-1', output: '7' }];
    const snapshot = structuredClone(history);
    const { original, omitted, corrupted } = replayVariants(protocol, history);
    expect(history).toEqual(snapshot);
    expect(original).toEqual(history);
    expect(original).not.toBe(history);
    expect(opaqueCount(protocol, original)).toBe(1);
    expect(opaqueCount(protocol, omitted)).toBe(0);
    expect(opaqueCount(protocol, corrupted)).toBe(1);
    const { [key]: ignored, ...rest } = original[0];
    expect(ignored).toBe('ABCD1234');
    expect(omitted).toEqual([rest, history[1]]);
    expect(corrupted).toEqual([{ ...rest, [key]: 'ABCDA234' }, history[1]]);
  });

  it.each(['chat', 'responses'] as const)('%s refuses a seed without opaque', protocol => {
    expect(() => replayVariants(protocol, [{ role: 'assistant', content: '7' }]))
      .toThrow('seed_has_no_opaque');
  });

  it('summarizes Chat without persisting text, opaque, IDs or absent usage as zero', () => {
    const result = summarize('chat', {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant', content: '7', reasoning_text: 'PRIVATE_TEXT',
          reasoning_opaque: 'PRIVATE_OPAQUE', id: 'PRIVATE_ID',
        },
      }],
    }, '7');
    expect(result).toEqual({
      terminal: 'stop', answerMatches: true, visibleTextLength: 1,
      opaqueCount: 1, inputTokens: null, outputTokens: null,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('keeps Responses incomplete distinct from a successful expected answer', () => {
    const result = summarize('responses', {
      status: 'incomplete',
      output: [
        { type: 'reasoning', id: 'PRIVATE_ID', summary: [], encrypted_content: 'PRIVATE_OPAQUE' },
        { type: 'message', content: [{ type: 'output_text', text: '7' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 512 },
    }, '7');
    expect(result).toMatchObject({
      terminal: 'incomplete', answerMatches: true, opaqueCount: 1, outputTokens: 512,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('reports only a boolean for upstream replay error text', () => {
    expect(errorMentionsReplay({ error: { message: 'invalid encrypted content PRIVATE_OPAQUE' } })).toBe(true);
    expect(errorMentionsReplay({ error: { message: 'model unavailable' } })).toBe(false);
  });

  it.each([false, true])('caps the harness at 12 calls and saves only summaries (target rejects: %s)', async rejects => {
    const directory = await mkdtemp(join(tmpdir(), 'thinking-compatibility-test-'));
    const reportPath = join(directory, 'summary.json');
    const requests: Record<string, unknown>[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      requests.push(body);
      const chat = String(url).endsWith('/chat/completions');
      const seed = typeof body.tool_choice === 'object';
      const changed = body.model === 'gemini-3.6-flash' || body.model === 'gpt-5-mini';
      const history = body.messages ?? body.input;
      if (!Array.isArray(history)) throw new Error('Fixture expected an input array');
      if (rejects && changed && history.length > 1) {
        return Response.json({ error: { message: 'invalid encrypted PRIVATE_OPAQUE' } }, { status: 400 });
      }
      const answer = JSON.stringify(history.at(-1)).includes('new turn') ? '8' : '7';
      if (chat) {
        return Response.json({
          choices: [{
            finish_reason: seed ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant', content: seed ? null : answer, reasoning_opaque: 'PRIVATE_OPAQUE',
              ...(seed ? { tool_calls: [{
                id: 'call-1', type: 'function',
                function: { name: 'fixture_value', arguments: '{"n":7}' },
              }] } : {}),
            },
          }],
        });
      }
      return Response.json({
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'PRIVATE_ID', summary: [], encrypted_content: 'PRIVATE_OPAQUE' },
          seed
            ? { type: 'function_call', call_id: 'call-1', name: 'fixture_value', arguments: '{"n":7}' }
            : { type: 'message', content: [{ type: 'output_text', text: answer }] },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await runLive(reportPath);
      const stored = await readFile(reportPath, 'utf8');
      const report = JSON.parse(stored);
      expect(fetchMock).toHaveBeenCalledTimes(12);
      expect(report).toMatchObject({ requestCount: 12, incomplete: false, protocolFailures: [] });
      expect(report.skipped).toHaveLength(rejects ? 2 : 0);
      expect(stored).not.toContain('PRIVATE');
      for (const body of requests) {
        expect(body.max_tokens ?? body.max_output_tokens).toBe(512);
        for (const key of ['reasoning', 'reasoning_effort', 'thinking', 'include', 'store', 'previous_response_id']) {
          expect(body).not.toHaveProperty(key);
        }
      }
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses an existing report before issuing any requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'thinking-compatibility-test-'));
    const reportPath = join(directory, 'summary.json');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await writeFile(reportPath, 'existing evidence');
      await expect(runLive(reportPath)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readFile(reportPath, 'utf8')).toBe('existing evidence');
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
