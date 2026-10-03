import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  OpenAIChatCompletionsClient,
  OpenAIResponsesClient,
} from '../../../src/builtins/providers/builtin/index.js';
import type { ChatMessage, ModelInvocationResponse } from '../../../src/core/model-invocation/types.js';
import { finalProjection, ProjectionTurn, type Result } from './projection.js';

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  assert(typeof value === 'string' && value.length > 0, 'Expected nonempty string');
  return value;
}

function responseText(response: ModelInvocationResponse): string {
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.toolCalls.length, 0, 'Control/final calls must not launch tools');
  return text(response.content.filter(block => block.type === 'text').map(block => block.text).join(''));
}

const [flag, seedPath, outputPath] = process.argv.slice(2);
assert(flag === '--live' && seedPath && outputPath,
  'Explicit invocation required: --live <prior-smoke-json> <output-json>');
const seed: unknown = JSON.parse(await readFile(seedPath, 'utf8'));
const seedRecord = record(seed);
assert.equal(seedRecord.model, 'gpt-5.4');
assert.equal(seedRecord.base, 'http://127.0.0.1:5000/v1');
assert(Array.isArray(seedRecord.requests));
const seeds = seedRecord.requests.map(record);
const evidence: {
  startedAt: string;
  finishedAt?: string;
  requests: Record<string, unknown>[];
  protocols: Record<string, unknown>[];
} = { startedAt: new Date().toISOString(), requests: [], protocols: [] };
const save = () => writeFile(outputPath, JSON.stringify(evidence, null, 2));
const deadline = Date.now() + 210_000;
const baseURL = 'http://127.0.0.1:5000/v1';

for (const protocol of ['chat/completions', 'responses']) {
  let phase = '';
  const entry: Record<string, unknown> = { protocol };
  evidence.protocols.push(entry);
  const fetchWithEvidence: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${baseURL}/${protocol}`, 'Unexpected endpoint');
    assert(evidence.requests.length < 6, 'Request budget exhausted');
    assert(init && typeof init.body === 'string', 'Expected JSON request body');
    const body: unknown = JSON.parse(init.body);
    const item: Record<string, unknown> = { protocol, phase, startedAt: new Date().toISOString(), body };
    evidence.requests.push(item);
    await save();
    console.log(`${item.startedAt} ${protocol} ${phase}: POST`);
    const response = await fetch(input, init);
    item.status = response.status;
    await save();
    return response;
  };
  const client = protocol === 'chat/completions'
    ? new OpenAIChatCompletionsClient({ baseURL, fetch: fetchWithEvidence })
    : new OpenAIResponsesClient({ baseURL, fetch: fetchWithEvidence });
  let release!: (value: Result) => void;
  const deferred = new Promise<Result>(resolve => { release = resolve; });
  let running: Promise<void> | undefined;
  let executions = 0;
  let toolSignal: AbortSignal | undefined;
  const invoke = async (messages: ChatMessage[], system: string): Promise<string> => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'Overall deadline exhausted');
    const response = await client.chat({
      model: 'gpt-5.4', messages, system,
      signal: AbortSignal.timeout(Math.min(60_000, remaining)),
    });
    const result = responseText(response);
    const latest = evidence.requests.at(-1);
    assert(latest);
    latest.response = response;
    latest.completedAt = new Date().toISOString();
    await save();
    console.log(`${protocol} ${phase}: ${result}`);
    return result;
  };
  try {
    const launch = seeds.find(item => item.protocol === protocol && item.phase === 'launch');
    assert(launch);
    assert.equal(launch.status, 200);
    const request = record(launch.request);
    const prefix = protocol === 'chat/completions' ? request.messages : request.input;
    assert(Array.isArray(prefix) && prefix.length === 1);
    const user = record(prefix[0]);
    assert.equal(user.role, 'user');
    const response = record(launch.response);
    let callId: string;
    if (protocol === 'chat/completions') {
      assert(Array.isArray(response.choices) && response.choices.length === 1);
      const message = record(record(response.choices[0]).message);
      assert(!message.content, 'This seed fixture expects no assistant text to omit');
      assert(Array.isArray(message.tool_calls) && message.tool_calls.length === 1);
      const call = record(message.tool_calls[0]);
      callId = text(call.id);
      const fn = record(call.function);
      assert.equal(fn.name, 'fixture_task');
      assert.deepEqual(JSON.parse(text(fn.arguments)), {});
    } else {
      assert.equal(response.status, 'completed');
      assert(Array.isArray(response.output));
      const calls = response.output.map(record).filter(item => item.type === 'function_call');
      assert.equal(calls.length, 1);
      callId = text(calls[0].call_id);
      assert.equal(calls[0].name, 'fixture_task');
      assert.deepEqual(JSON.parse(text(calls[0].arguments)), {});
      assert(response.output.map(record).every(item => item.type === 'function_call'
        || item.type === 'reasoning'), 'Unexpected assistant content in seed');
    }
    entry.seedCallId = callId;
    const root = new AbortController();
    const turn = new ProjectionTurn(
      [{ role: 'user', content: text(user.content) }],
      [{ id: callId, name: 'fixture_task', input: {} }],
      async (_call, context) => {
        executions++;
        toolSignal = context.signal;
        return deferred;
      },
      async messages => ({
        reply: await invoke(messages, 'This is a synthetic tool-execution test. The host snapshot is authoritative. The task has already started; do not restart it. No progress counts have been reported. Answer steering, remember earlier reminders, and never invent progress.'),
        action: 'keep',
      }),
      root.signal,
    );
    running = turn.start();
    const facts = [];
    for (const [id, message] of [
      ['note', '加个 NOTE：完成后提醒我查看 xxx 数据。'],
      ['progress', '现在下载了多少文件了？'],
    ]) {
      phase = id;
      await turn.steer(id, message);
      assert.equal(executions, 1);
      assert.equal(toolSignal?.aborted, false);
      assert.equal(root.signal.aborted, false);
      assert.equal(turn.snapshot().facts.filter(fact => fact.kind === 'result').length, 0);
      assert.throws(() => finalProjection(turn.snapshot()), /Pending\/unknown/);
      facts.push(turn.snapshot());
    }
    release({ outcome: 'success', content: 'Synthetic task complete: exactly 7 fixture files processed.' });
    await running;
    const snapshot = turn.snapshot();
    assert.equal(snapshot.facts.filter(fact => fact.kind === 'result').length, 1);
    assert.equal(snapshot.facts.filter(fact => fact.kind === 'steering').length, 2);
    assert.equal(snapshot.facts.filter(fact => fact.kind === 'reply').length, 2);
    const merged = finalProjection(snapshot);
    assert.deepEqual(turn.snapshot(), snapshot, 'Projection must not rewrite facts');
    phase = 'final';
    entry.finalReply = await invoke(merged, 'The tool has now completed. Give its actual final result and honor earlier reminders. The annotated steering/replies occurred while results were unavailable; do not confuse those observations with the now-known result.');
    entry.pendingSnapshots = facts;
    entry.finalSnapshot = snapshot;
    entry.finalProjection = merged;
    entry.result = 'passed';
  } catch (error) {
    entry.error = String(error);
    console.error(`${protocol}: ${error}`);
    process.exitCode = 1;
  } finally {
    release({ outcome: 'success', content: 'Fixture cleanup' });
    await running;
    await save();
  }
}
evidence.finishedAt = new Date().toISOString();
await save();
