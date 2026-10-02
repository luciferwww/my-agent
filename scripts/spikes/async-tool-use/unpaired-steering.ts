import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value), 'Expected array');
  return value;
}
function string(value: unknown): string {
  assert(typeof value === 'string' && value.length > 0, 'Expected nonempty string');
  return value;
}

const [flag, keyPath, outputPath, onlyProtocol] = process.argv.slice(2);
assert(flag === '--live' && keyPath && outputPath, 'Usage: --live <siliconflow-key-file> <evidence-file>');
assert(onlyProtocol === undefined || onlyProtocol === 'chat/completions', 'Unsupported protocol selection');
let apiKey: string | undefined;
let credentialError: string | undefined;
try {
  apiKey = (await readFile(keyPath, 'utf8')).trim();
  assert(apiKey && !/\s/.test(apiKey), 'Invalid temporary credential file');
} catch {
  credentialError = 'Temporary credential file unavailable or invalid; Messages test will be skipped';
  console.error(credentialError);
}
const redact = (value: string) => apiKey ? value.split(apiKey).join('[REDACTED]') : value;
const evidence: {
  startedAt: string;
  finishedAt?: string;
  requests: Record<string, unknown>[];
  scenarios: Record<string, unknown>[];
} = { startedAt: new Date().toISOString(), requests: [], scenarios: [] };
const save = () => writeFile(outputPath, redact(JSON.stringify(evidence, null, 2)));
const prefix = [{ role: 'user', content: 'Call fixture_task exactly once with {} to start a synthetic task. It has no real-world side effects. Wait for its result before reporting completion.' }];
const steering = { role: 'user', content: 'The previously requested tool is still running; no tool result is available yet. Please acknowledge this NOTE: remind me to inspect xxx data when the task finishes. Do not call the tool again.' };
const actualResult = 'Synthetic fixture completed successfully: exactly 7 files processed.';
const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false };
let count = 0;

for (const protocol of onlyProtocol ? [onlyProtocol] : ['chat/completions', 'responses', 'messages']) {
  const anthropic = protocol === 'messages';
  const model = anthropic ? 'zai-org/GLM-5.3' : 'gpt-5.4';
  const url = anthropic
    ? 'https://api.siliconflow.cn/v1/messages'
    : `http://127.0.0.1:5000/v1/${protocol}`;
  const scenario: Record<string, unknown> = { protocol, model, url };
  evidence.scenarios.push(scenario);
  if (anthropic && credentialError) {
    scenario.error = credentialError;
    process.exitCode = 1;
    await save();
    continue;
  }
  let release!: (value: string) => void;
  let settled = false;
  const fixture = new Promise<string>(resolve => { release = resolve; }).then(value => {
    settled = true;
    return value;
  });
  const request = async (phase: string, body: Record<string, unknown>) => {
    assert(++count <= 9, 'Nine-generation budget exhausted');
    const entry: Record<string, unknown> = {
      protocol, phase, startedAt: new Date().toISOString(), body,
    };
    evidence.requests.push(entry);
    await save();
    console.log(`${entry.startedAt} ${protocol} ${phase}: POST`);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (anthropic) {
        assert(apiKey);
        headers.authorization = `Bearer ${apiKey}`;
        headers['anthropic-version'] = '2023-06-01';
      }
      const response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000), redirect: 'error',
      });
      entry.status = response.status;
      const raw = await response.text();
      entry.raw = raw;
      console.log(`${protocol} ${phase}: HTTP ${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 1600)}`);
      const result: unknown = JSON.parse(raw);
      return object(result);
    } catch (error) {
      entry.error = redact(String(error));
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
      await save();
    }
  };
  const body = (history: unknown[]): Record<string, unknown> => protocol === 'responses'
    ? { model, stream: false, max_output_tokens: 2048, input: history }
    : anthropic
      ? { model, stream: false, max_tokens: 2048, messages: history }
      : { model, stream: false, max_completion_tokens: 2048, messages: history };
  const assistant = (response: Record<string, unknown>, expectCall: boolean): unknown[] => {
    if (protocol === 'responses') {
      assert.equal(response.status, 'completed', 'Responses did not complete');
      const output = array(response.output).map(object);
      const calls = output.filter(item => item.type === 'function_call');
      assert.equal(calls.length, expectCall ? 1 : 0, 'Unexpected Responses call count');
      return output;
    }
    if (anthropic) {
      assert.equal(response.stop_reason, expectCall ? 'tool_use' : 'end_turn');
      const content = array(response.content).map(object);
      assert.equal(content.filter(item => item.type === 'tool_use').length, expectCall ? 1 : 0);
      return [{ role: 'assistant', content }];
    }
    const choices = array(response.choices);
    assert.equal(choices.length, 1);
    const choice = object(choices[0]);
    assert.equal(choice.finish_reason, expectCall ? 'tool_calls' : 'stop');
    const message = object(choice.message);
    assert.equal(message.role, 'assistant');
    assert.equal(message.tool_calls === undefined ? 0 : array(message.tool_calls).length, expectCall ? 1 : 0);
    return [message];
  };
  try {
    const launchBody = body(prefix);
    if (protocol === 'responses') {
      launchBody.tools = [{ type: 'function', name: 'fixture_task', description: 'Start a synthetic fixture.', parameters }];
      launchBody.tool_choice = { type: 'function', name: 'fixture_task' };
    } else if (anthropic) {
      launchBody.tools = [{ name: 'fixture_task', description: 'Start a synthetic fixture.', input_schema: parameters }];
      launchBody.tool_choice = { type: 'tool', name: 'fixture_task' };
    } else {
      launchBody.tools = [{ type: 'function', function: { name: 'fixture_task', description: 'Start a synthetic fixture.', parameters } }];
      launchBody.tool_choice = { type: 'function', function: { name: 'fixture_task' } };
    }
    const launch = await request('launch', launchBody);
    const original = assistant(launch, true);
    let callId: string;
    if (protocol === 'responses') {
      const call = original.map(object).find(item => item.type === 'function_call');
      assert(call);
      assert.equal(call.name, 'fixture_task');
      callId = string(call.call_id);
      assert.deepEqual(JSON.parse(string(call.arguments)), {});
    } else if (anthropic) {
      const call = array(launch.content).map(object).find(item => item.type === 'tool_use');
      assert(call);
      assert.equal(call.name, 'fixture_task');
      callId = string(call.id);
      assert.deepEqual(call.input, {});
    } else {
      const call = object(array(object(original[0]).tool_calls)[0]);
      const fn = object(call.function);
      assert.equal(fn.name, 'fixture_task');
      assert.deepEqual(JSON.parse(string(fn.arguments)), {});
      callId = string(call.id);
    }
    scenario.callId = callId;
    scenario.fixtureExecutions = 1;
    const unpairedHistory = [...prefix, ...original, steering];
    const middle = await request('unpaired-steering', body(unpairedHistory));
    const middleAssistant = assistant(middle, false);
    scenario.steeringResponse = middle;
    scenario.pendingWhenSteeringReturned = !settled;
    assert(!settled, 'Fixture must remain pending through steering');
    console.log(`${protocol}: pending steering accepted; response saved`);
    release(actualResult);
    const result = await fixture;
    const resultMessage = protocol === 'responses'
      ? { type: 'function_call_output', call_id: callId, output: result }
      : anthropic
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: result }] }
        : { role: 'tool', tool_call_id: callId, content: result };
    // Append strictly chronologically; never move the result next to its call.
    const finalHistory = [...unpairedHistory, ...middleAssistant, resultMessage];
    const final = await request('late-result', body(finalHistory));
    assistant(final, false);
    scenario.finalResponse = final;
    scenario.mechanism = 'accepted-unpaired-steering-and-chronological-late-result';
    console.log(`${protocol}: chronological late result accepted; response saved`);
  } catch (error) {
    scenario.error = redact(String(error));
    process.exitCode = 1;
    console.error(redact(`${protocol}: ${error}`));
  } finally {
    release('Fixture cleanup; not sent as a result');
    await fixture;
    await save();
  }
}
evidence.finishedAt = new Date().toISOString();
await save();
console.log(`Finished ${count} generation requests; no retries.`);
