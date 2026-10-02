import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage } from '../../src/core/model-invocation/index.js';
import { AnthropicMessagesClient } from '../../src/builtins/providers/builtin/AnthropicMessagesClient.js';
import { OpenAIResponsesClient } from '../../src/builtins/providers/builtin/OpenAIResponsesClient.js';
import { CopilotRelayResponsesClient } from './responses-client.js';
import { SessionManager } from '../../src/core/session/SessionManager.js';
import { randomUUID } from 'node:crypto';
import {
  PrototypeJournal, projectPrototype,
  type PrototypeBlock, type PrototypeContext, type PrototypeMessage, type PrototypeRequest,
} from './thinking-recovery-prototype.spike.js';

// Synthetic complete blocks only; this experiment does not implement streaming or real API validation.
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const context = (protocol: PrototypeContext['protocol']): PrototypeContext => ({
  providerId: 'fixture', routeId: 'fixture-route', model: 'fixture-model', protocol,
  system: 'Fixed synthetic system.',
  tools: [{ name: 'lookup', description: 'Fixture lookup.', inputSchema: { type: 'object', additionalProperties: false } }],
});
const longResult = 'H'.repeat(16) + 'M'.repeat(600) + 'T'.repeat(8);
const boundedResult = `${'H'.repeat(16)}\n\n...\n\n${'T'.repeat(8)}`
  + '\n\n[Tool result trimmed: kept first 16 and last 8 of 624 chars]';
// Deterministic budget oracle for control flow, not an estimate of encrypted reasoning tokens.
const budget = (limit: number) => ({ limit, estimate: (_request: PrototypeRequest) => 100 });
const capture = () => vi.fn(async (_request: PrototypeRequest) => {});

function round(protocol: PrototypeContext['protocol'], index: number): PrototypeBlock[] {
  const thinking: PrototypeBlock[] = protocol === 'anthropic-messages'
    ? [
        { type: 'thinking', id: `inv-${index}:0`, thinking: `thought-${index}`, signature: `fixture-sig-${index}` },
        { type: 'redacted_thinking', id: `inv-${index}:1`, data: `fixture-redacted-${index}` },
      ]
    : [{
        type: 'reasoning', id: `rs-${index}`, summary: index === 1 ? [] : [{ type: 'summary_text', text: 'summary-2' }],
        encrypted_content: `fixture-cipher-${index}`, status: 'completed',
      }];
  return [...thinking, { type: 'text', text: `step-${index}` }, {
    type: 'tool_use', id: `call-${index}`, name: 'lookup', input: { index },
  }];
}

async function fixture(protocol: PrototypeContext['protocol']) {
  const home = await mkdtemp(join(tmpdir(), 'thinking-recovery-target-'));
  directories.push(home);
  const file = join(home, 'prototype.jsonl');
  const settings = context(protocol);
  const journal = await PrototypeJournal.create(file, settings);
  await journal.appendUser('Look up two fixture values.');
  return { file, settings, journal };
}

async function completedLoop(protocol: PrototypeContext['protocol']) {
  const result = await fixture(protocol);
  const transport = capture();
  await result.journal.send(result.settings, budget(10_000), transport);
  await result.journal.appendAssistant(round(protocol, 1));
  expect(await result.journal.appendToolResult('call-1', longResult, 200)).toBe(boundedResult);
  await result.journal.send(result.settings, budget(10_000), transport);
  await result.journal.appendAssistant(round(protocol, 2));
  expect(await result.journal.appendToolResult('call-2', 'short-result', 200)).toBe('short-result');
  return { ...result, transport };
}

describe('Thinking recovery target spike: candidate, not production acceptance', () => {
  it.each(['anthropic-messages', 'openai-responses'] as const)(
    '%s: preserves two tool rounds, bounds once and replays from a fresh disk load',
    async (protocol) => {
      const { file, journal, settings, transport } = await completedLoop(protocol);
      const before = await journal.send(settings, budget(10_000), transport);
      const reloaded = await PrototypeJournal.load(file);
      const estimate = vi.fn((_request: PrototypeRequest) => 100);
      const after = await reloaded.send(settings, { limit: 200, estimate }, transport);
      expect(after).toEqual(before);
      expect(estimate).toHaveBeenCalledWith(before);
      expect(reloaded.messages()).toEqual(journal.messages());
      const serialized = JSON.stringify(after);
      expect(serialized).toContain('short-result');
      expect(serialized).not.toContain(longResult);
      expect(serialized).not.toContain('protectedDigest');
      expect(serialized).not.toContain('fixture-route');
      expect(after).not.toHaveProperty('store');
      expect(after).not.toHaveProperty('previous_response_id');
      if (protocol === 'anthropic-messages') {
        expect(after.messages).toEqual([
          { role: 'user', content: [{ type: 'text', text: 'Look up two fixture values.' }] },
          ...[1, 2].flatMap((index) => [
            { role: 'assistant', content: [
              { type: 'thinking', thinking: `thought-${index}`, signature: `fixture-sig-${index}` },
              { type: 'redacted_thinking', data: `fixture-redacted-${index}` },
              { type: 'text', text: `step-${index}` },
              { type: 'tool_use', id: `call-${index}`, name: 'lookup', input: { index } },
            ] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`,
              content: index === 1 ? boundedResult : 'short-result' }] },
          ]),
        ]);
      } else {
        expect(after.input).toEqual([
          { role: 'user', content: [{ type: 'input_text', text: 'Look up two fixture values.' }] },
          ...[1, 2].flatMap((index) => [
            { type: 'reasoning', id: `rs-${index}`,
              summary: index === 1 ? [] : [{ type: 'summary_text', text: 'summary-2' }],
              encrypted_content: `fixture-cipher-${index}`, status: 'completed' },
            { role: 'assistant', content: [{ type: 'output_text', text: `step-${index}` }] },
            { type: 'function_call', call_id: `call-${index}`, name: 'lookup', arguments: `{"index":${index}}` },
            { type: 'function_call_output', call_id: `call-${index}`, output: index === 1 ? boundedResult : 'short-result' },
          ]),
        ]);
      }
      const rows = (await readFile(file, 'utf8')).trim().split('\n');
      expect(rows).toHaveLength(6);
      expect(rows.filter((line) => line.includes('"replay-context"'))).toHaveLength(1);
      expect(rows.slice(1).every((line) => !line.includes('"system"') && !line.includes('"messages"'))).toBe(true);
    },
  );

  it.each(['system', 'tools', 'route', 'protocol'] as const)(
    'reports changed %s before dispatch, without silently restoring old settings',
    async (field) => {
      const { file, settings } = await completedLoop('anthropic-messages');
      const journal = await PrototypeJournal.load(file);
      const changed = structuredClone(settings);
      if (field === 'system') changed.system = 'New instructions.';
      if (field === 'tools') changed.tools[0]!.inputSchema = { type: 'object', required: ['new-argument'] };
      if (field === 'route') changed.routeId = 'different-route';
      if (field === 'protocol') changed.protocol = 'openai-responses';
      const disk = await readFile(file, 'utf8');
      const transport = capture();
      await expect(journal.send(changed, budget(200), transport)).rejects.toMatchObject({ code: 'context_changed' });
      expect(transport).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe(disk);
    },
  );

  it.each(['tool-result-edit', 'thinking-gap', 'compaction-keeps-suffix', 'compaction-drops-all'] as const)(
    'rejects %s before budget evaluation or dispatch',
    async (change) => {
      const { journal, settings } = await completedLoop('anthropic-messages');
      const original = journal.messages();
      let candidate = structuredClone(original);
      if (change === 'tool-result-edit') candidate[2]!.content = [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'rewritten',
        status: 'success',
      }];
      if (change === 'thinking-gap') candidate[1]!.content = candidate[1]!.content.filter((block) => block.type !== 'thinking');
      if (change.startsWith('compaction')) {
        candidate = [{
          type: 'message', id: 'summary', role: 'user', content: [{ type: 'text', text: 'Synthetic summary.' }],
        }, ...(change === 'compaction-keeps-suffix' ? candidate.slice(3) : [])];
      }
      const estimate = vi.fn((_request: PrototypeRequest) => 100);
      const transport = capture();
      await expect(async () => transport(journal.prepare(settings, { limit: 200, estimate }, candidate)))
        .rejects.toMatchObject({ code: 'prefix_changed' });
      expect(estimate).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(journal.messages()).toEqual(original);
    },
  );

  it('allows appended user content without rebuilding already prepared user messages', async () => {
    const { journal, settings } = await completedLoop('anthropic-messages');
    const before = journal.messages();
    await journal.appendUser('[New context hook output]\nContinue.');
    await expect(journal.send(settings, budget(200), capture())).resolves.toHaveProperty('messages');
    expect(journal.messages().slice(0, before.length)).toEqual(before);
  });

  it('accepts object-key reordering in equivalent tool schemas', async () => {
    const { journal, settings } = await completedLoop('anthropic-messages');
    const reordered: PrototypeContext = {
      ...settings, tools: settings.tools.map((tool) => ({
        inputSchema: Object.fromEntries(Object.entries(tool.inputSchema).reverse()),
        description: tool.description, name: tool.name,
      })),
    };
    await expect(journal.send(reordered, budget(200), capture())).resolves.toHaveProperty('messages');
  });

  it('blocks at 99, accepts at 100, and never prunes protected content to satisfy a smaller budget', async () => {
    const { file, journal, settings } = await completedLoop('anthropic-messages');
    const before = await readFile(file, 'utf8');
    const transport = capture();
    await expect(journal.send(settings, budget(99), transport)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(transport).not.toHaveBeenCalled();
    await expect(journal.send(settings, budget(100), transport)).resolves.toHaveProperty('messages');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it.each(['missing-signature', 'incomplete-item', 'changed-persisted-prefix'] as const)(
    'fails explicitly while reloading %s',
    async (corruption) => {
      const protocol = corruption === 'incomplete-item' ? 'openai-responses' : 'anthropic-messages';
      const { file } = await completedLoop(protocol);
      const original = await readFile(file, 'utf8');
      const changed = corruption === 'missing-signature'
        ? original.replace('"signature":"fixture-sig-1"', '"signature":""')
        : corruption === 'incomplete-item'
          ? original.replace('"status":"completed"', '"status":"incomplete"')
          : original.replace('Look up two fixture values.', 'Changed earlier input.');
      expect(changed).not.toBe(original);
      await writeFile(file, changed);
      await expect(PrototypeJournal.load(file)).rejects.toMatchObject({
        code: corruption === 'changed-persisted-prefix' ? 'prefix_changed' : 'invalid_record',
      });
    },
  );

  it('does not commit memory state when persistence fails', async () => {
    const { journal, file } = await fixture('anthropic-messages');
    const before = journal.messages();
    await rm(file);
    // A missing parent makes appendFile fail rather than create a replacement file.
    const directory = directories[directories.length - 1]!;
    await rm(directory, { recursive: true });
    await expect(journal.appendToolResult('call-1', longResult, 200)).rejects.toHaveProperty('code', 'ENOENT');
    expect(journal.messages()).toEqual(before);
  });

  it('preserves missing and null encrypted_content without manufacturing ciphertext', async () => {
    const { journal, settings, file } = await fixture('openai-responses');
    await journal.appendAssistant([
      { type: 'reasoning', id: 'empty-summary', summary: [] },
      { type: 'reasoning', id: 'null-cipher', summary: [], encrypted_content: null },
    ]);
    const reloaded = await PrototypeJournal.load(file);
    expect((await reloaded.send(settings, budget(200), capture())).input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Look up two fixture values.' }] },
      { type: 'reasoning', id: 'empty-summary', summary: [] },
      { type: 'reasoning', id: 'null-cipher', summary: [], encrypted_content: null },
    ]);
  });

  it('can preview an unprotected compaction candidate without dispatching or committing it', async () => {
    const { journal, settings } = await fixture('anthropic-messages');
    const summary: PrototypeMessage = {
      type: 'message', id: 'summary', role: 'user', content: [{ type: 'text', text: 'Unprotected summary.' }],
    };
    const before = journal.messages();
    const request = journal.prepare(settings, budget(100), [summary]);
    expect(request.messages).toEqual([{ role: 'user', content: summary.content }]);
    expect(journal.messages()).toEqual(before);
  });

  it('rejects cross-protocol opaque content without writing it', async () => {
    const { journal, file } = await fixture('openai-responses');
    const before = await readFile(file, 'utf8');
    await expect(journal.appendAssistant(round('anthropic-messages', 1)))
      .rejects.toMatchObject({ code: 'protocol_mismatch' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('preserves every modeled optional reasoning field', async () => {
    const { journal, settings, file } = await fixture('openai-responses');
    const item: PrototypeBlock = {
      type: 'reasoning', id: 'rs-complete', summary: [{ type: 'summary_text', text: 'Summary fixture.' }],
      content: [{ type: 'reasoning_text', text: 'Returned content fixture.' }],
      encrypted_content: 'fixture-cipher', status: 'completed',
    };
    await journal.appendAssistant([item]);
    const restored = await PrototypeJournal.load(file);
    expect((await restored.send(settings, budget(100), capture())).input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Look up two fixture values.' }] }, item,
    ]);
  });

  it('characterizes the integration seam: current Session cap would trim an already bounded result again', async () => {
    const home = await mkdtemp(join(tmpdir(), 'thinking-double-cap-'));
    directories.push(home);
    const sessions = new SessionManager(home, { toolResultHeadChars: 16, toolResultTailChars: 8 });
    const sessionId = randomUUID();
    await sessions.materializeSession({ sessionId, createdAt: Date.now() });
    await sessions.appendMessage(sessionId, {
      turnId: 'fixture-turn', role: 'toolResult',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: boundedResult,
        status: 'success',
      }],
    });
    expect(sessions.getMessages(sessionId)[0]?.message.content).not.toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: boundedResult, status: 'success' },
    ]);
  });
});

describe('Prototype ordinary-message projection parity with actual Clients', () => {
  for (const Client of [AnthropicMessagesClient, OpenAIResponsesClient, CopilotRelayResponsesClient]) {
    it(Client.name, async () => {
      const protocol = Client === AnthropicMessagesClient ? 'anthropic-messages' : 'openai-responses';
      const settings = context(protocol);
      const messages: ChatMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Fixture input.' }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'Before tool.' }, { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} },
          { type: 'text', text: 'After tool.' },
        ] },
        { role: 'user', content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'Fixture output.',
          status: 'success',
        }] },
      ];
      const candidate: PrototypeMessage[] = messages.map((message, index) => ({
        type: 'message', id: String(index), role: message.role,
        content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
          : message.content.filter((block): block is Extract<PrototypeBlock, { type: 'text' | 'tool_use' | 'tool_result' }> =>
              block.type === 'text' || block.type === 'tool_use' || block.type === 'tool_result'),
      }));
      const bodies: unknown[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const events = protocol === 'anthropic-messages'
          ? [
              { type: 'message_start', message: { usage: { input_tokens: 1 } } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
              { type: 'message_stop' },
            ]
          : [
              { type: 'response.created', response: { id: 'fixture-response' } },
              { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } },
            ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      };
      await new Client({ baseURL: 'https://fixture.invalid', fetch: fetchImpl }).chat({
        model: settings.model, system: settings.system, tools: settings.tools, messages,
      });
      expect(bodies).toHaveLength(1);
      const body = bodies[0];
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid captured fixture body.');
      const withoutTransportOptions = Object.fromEntries(Object.entries(body).filter(
        ([key]) => !['stream', 'max_tokens', 'max_output_tokens'].includes(key),
      ));
      expect(withoutTransportOptions).toEqual(projectPrototype(settings, candidate));
    });
  }
});
