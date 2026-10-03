import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}
const [flag, evidenceDirectory] = process.argv.slice(2);
assert(flag === '--live' && evidenceDirectory, 'Usage: --live <session-files-directory>');
const { join } = await import('node:path');
const output = join(evidenceDirectory, 'relay-steer-control-results.json');
const records: Record<string, unknown>[] = [];
const save = () => writeFile(output, JSON.stringify(records, null, 2));
const note = { role: 'user', content: 'Please acknowledge this note: when the task completes, remind me to inspect the report. Do not call any tool again.' };

for (const protocol of ['chat/completions', 'responses']) {
  const file = protocol === 'chat/completions'
    ? 'unpaired-chat-corrected-results.json' : 'unpaired-steering-results.json';
  const seed = object(JSON.parse(await readFile(join(evidenceDirectory, file), 'utf8')));
  const launch = array(seed.requests).map(object).find(item => item.protocol === protocol && item.phase === 'launch');
  assert(launch && launch.status === 200);
  const original = object(JSON.parse(String(launch.raw)));
  const initial = object(launch.body);
  const prefix = array(protocol === 'responses' ? initial.input : initial.messages);
  let history: unknown[];
  let callId: unknown;
  if (protocol === 'chat/completions') {
    const message = object(object(array(original.choices)[0]).message);
    const calls = array(message.tool_calls).map(object).map(call => {
      const fn = object(call.function);
      return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
    });
    assert.equal(calls.length, 1);
    callId = calls[0].id;
    history = [...prefix, { role: 'assistant', content: message.content ?? null, tool_calls: calls }];
  } else {
    const items = array(original.output).map(object).map(item => {
      if (item.type === 'reasoning') {
        return { type: 'reasoning', summary: item.summary, encrypted_content: item.encrypted_content };
      }
      assert.equal(item.type, 'function_call');
      callId = item.call_id;
      return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments };
    });
    history = [...prefix, ...items];
  }
  assert(typeof callId === 'string');
  let release!: (value: string) => void;
  let completed = false;
  const runningTool = new Promise<string>(resolve => { release = resolve; }).then(value => {
    completed = true;
    return value;
  });
  const request = async (phase: string, messages: unknown[]) => {
    const body = protocol === 'responses'
      ? { model: 'gpt-5.4', stream: false, max_output_tokens: 2048, input: messages }
      : { model: 'gpt-5.4', stream: false, max_completion_tokens: 2048, messages };
    const record: Record<string, unknown> = {
      protocol, phase, startedAt: new Date().toISOString(), fixturePendingBefore: !completed, body,
    };
    records.push(record);
    await save();
    console.log(`${record.startedAt} ${protocol} ${phase}: POST`);
    try {
      const response = await fetch(`http://127.0.0.1:5000/v1/${protocol}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000), redirect: 'error',
      });
      record.status = response.status;
      record.raw = await response.text();
      record.fixturePendingAfter = !completed;
      console.log(`${protocol} ${phase}: HTTP ${response.status}; tool pending=${!completed}`);
      if (!response.ok) console.log(String(record.raw));
    } catch (error) {
      record.error = String(error);
      console.error(error);
      process.exitCode = 1;
    } finally {
      record.finishedAt = new Date().toISOString();
      await save();
    }
  };
  try {
    await request('steer-while-tool-running', [...history, note]);
    assert.equal(completed, false);
    release('Synthetic fixture actually completed; seven files processed.');
    const result = await runningTool;
    const resultItem = protocol === 'responses'
      ? { type: 'function_call_output', call_id: callId, output: result }
      : { role: 'tool', tool_call_id: callId, content: result };
    // Only this correlated result is added; all other request fields stay identical.
    await request('paired-control', [...history, resultItem, note]);
  } finally {
    release('Cleanup');
    await runningTool;
  }
}
