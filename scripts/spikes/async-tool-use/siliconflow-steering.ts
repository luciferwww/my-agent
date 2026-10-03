import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  AnthropicMessagesClient,
  OpenAIChatCompletionsClient,
} from '../../../src/builtins/providers/builtin/index.js';
import type { ChatMessage, ModelInvocationResponse } from '../../../src/core/model-invocation/types.js';
import { finalProjection, ProjectionTurn, type Result } from './projection.js';

const [flag, keyPath, outputPath, selectedModel] = process.argv.slice(2);
assert(flag === '--live' && keyPath && outputPath, 'Usage: --live <key-file> <evidence-file> [model]');
const apiKey = (await readFile(keyPath, 'utf8')).trim();
assert(apiKey.length > 0 && !/\s/.test(apiKey), 'Key file must contain one nonempty token');
const baseURL = 'https://api.siliconflow.cn/v1';
const model = selectedModel ?? 'deepseek-ai/DeepSeek-V4-Flash';
assert(['deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.3'].includes(model), 'Model not authorized');
const runNegative = model === 'deepseek-ai/DeepSeek-V4-Flash';
const requestBudget = runNegative ? 9 : 8;
const evidence: { model: string; startedAt: string; requests: Record<string, unknown>[]; scenarios: Record<string, unknown>[] } =
  { model, startedAt: new Date().toISOString(), requests: [], scenarios: [] };
const clean = (value: string) => value.split(apiKey).join('[REDACTED]');
const save = () => writeFile(outputPath, clean(JSON.stringify(evidence, null, 2)));
const deadline = Date.now() + 540_000;
let generationCount = 0;
let phase = 'models';
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.siliconflow.cn');
  assert(['/v1/models', '/v1/messages', '/v1/chat/completions'].includes(url.pathname));
  const remaining = deadline - Date.now();
  assert(remaining > 0, 'Overall deadline exhausted');
  if (init?.method === 'POST') assert(++generationCount <= requestBudget, 'Generation budget exhausted');
  const headers = new Headers(init?.headers);
  headers.delete('x-api-key');
  headers.set('authorization', `Bearer ${apiKey}`);
  const item: Record<string, unknown> = { path: url.pathname, phase, startedAt: new Date().toISOString() };
  if (typeof init?.body === 'string') item.body = JSON.parse(init.body);
  evidence.requests.push(item);
  await save();
  console.log(`${item.startedAt} ${url.pathname} ${phase}: request`);
  try {
    const timeout = AbortSignal.timeout(Math.min(60_000, remaining));
    const response = await fetch(url, {
      ...init, headers, redirect: 'error',
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    item.status = response.status;
    const raw = await response.text();
    assert(raw.length <= 2_000_000, 'Unexpectedly large response');
    item.raw = raw;
    console.log(`${url.pathname} ${phase}: HTTP ${response.status}`);
    return new Response(raw, { status: response.status, headers: response.headers });
  } catch (error) {
    item.error = clean(String(error));
    throw error;
  } finally {
    item.finishedAt = new Date().toISOString();
    await save();
  }
};

function reply(response: ModelInvocationResponse): string {
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.toolCalls.length, 0);
  const result = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
  assert(result.trim(), 'Missing text reply');
  return result;
}

const catalog = await transport(`${baseURL}/models`, { method: 'GET' });
assert(catalog.ok, `Catalog HTTP ${catalog.status}; no generation attempted`);
const catalogText = await catalog.text();
assert(catalogText.includes(`"${model}"`), 'Requested model not advertised; no generation attempted');
console.log(`Catalog advertises ${model}`);

for (const protocol of ['messages', 'chat/completions']) {
  const entry: Record<string, unknown> = { protocol };
  evidence.scenarios.push(entry);
  const client = protocol === 'messages'
    ? new AnthropicMessagesClient({ baseURL, fetch: transport })
    : new OpenAIChatCompletionsClient({ baseURL, fetch: transport });
  let release!: (result: Result) => void;
  const pending = new Promise<Result>(resolve => { release = resolve; });
  let running: Promise<void> | undefined;
  const prefix: ChatMessage[] = [{ role: 'user', content: 'Start a synthetic download by calling fixture_task exactly once with {}. There are no actual files or network operations. Do not report completion before receiving its result.' }];
  const invoke = async (messages: ChatMessage[], system: string) => {
    const response = await client.chat({ model, messages, system, outputTokenLimit: 1024 });
    const latest = evidence.requests.at(-1);
    assert(latest);
    latest.decoded = response;
    await save();
    const text = reply(response);
    console.log(clean(`${protocol} ${phase}: ${text}`));
    return text;
  };
  try {
    phase = 'launch';
    const launch = await client.chat({
      model, messages: prefix, outputTokenLimit: 1024,
      tools: [{ name: 'fixture_task', description: 'Start one synthetic fixture task.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    entry.launch = launch;
    assert.equal(launch.toolCalls.length, 1, 'Expected one real model call');
    const call = launch.toolCalls[0];
    assert.equal(call.name, 'fixture_task');
    assert(call.input.state === 'ready');
    assert.deepEqual(call.input.value, {});
    let executions = 0;
    let signal: AbortSignal | undefined;
    const root = new AbortController();
    const turn = new ProjectionTurn(prefix, [{ id: call.callId, name: call.name, input: {} }],
      async (_call, context) => { executions++; signal = context.signal; return pending; },
      async messages => ({
        reply: await invoke(messages, 'This is a synthetic execution test. The task has already started. No progress counts have been reported. Answer steering, remember reminders, do not restart the tool or invent progress.'),
        action: 'keep',
      }), root.signal);
    running = turn.start();
    for (const [id, message] of [
      ['note', '加个 NOTE：完成后提醒我查看 xxx 数据。'],
      ['progress', '现在下载了多少文件了？'],
    ]) {
      phase = id;
      await turn.steer(id, message);
      assert.equal(executions, 1);
      assert.equal(signal?.aborted, false);
      assert.equal(root.signal.aborted, false);
      assert.equal(turn.snapshot().facts.filter(fact => fact.kind === 'result').length, 0);
      assert.throws(() => finalProjection(turn.snapshot()), /Pending\/unknown/);
    }
    release({ outcome: 'success', content: 'Synthetic task completed: exactly 7 fixture files processed.' });
    await running;
    const snapshot = turn.snapshot();
    const merged = finalProjection(snapshot);
    // Preserve any initial assistant text alongside the original calls.
    merged[prefix.length] = { role: 'assistant', content: launch.content };
    phase = 'final';
    entry.finalReply = await invoke(merged, 'The task has now completed. Give its actual result and honor the earlier NOTE. Annotated control replies describe what was known while the task was pending.');
    entry.snapshot = snapshot;
    entry.transportAndLifecycle = 'passed';
    entry.semanticReview = 'required';
    entry.finalHasExpectedCount = /\b7\b|七/.test(String(entry.finalReply));
    entry.finalHasReminder = /xxx/i.test(String(entry.finalReply));
    if (!entry.finalHasExpectedCount || !entry.finalHasReminder) {
      console.log(`${protocol}: quality observation: final response is missing the expected count or reminder; not a mechanism failure`);
    }
    if (protocol === 'messages' && runNegative) {
      phase = 'unpaired-negative';
      const response = await transport(`${baseURL}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model, max_tokens: 256, stream: false,
          messages: [...prefix, { role: 'assistant', content: launch.content },
            { role: 'user', content: 'The tool is still pending with no result. Just acknowledge this note.' }],
        }),
      });
      entry.unpairedHTTP = response.status;
      console.log(`Messages missing-result negative: HTTP ${response.status} (not a conformance verdict)`);
    }
  } catch (error) {
    entry.error = clean(String(error));
    console.error(clean(`${protocol}: ${error}`));
    process.exitCode = 1;
  } finally {
    release({ outcome: 'success', content: 'Fixture cleanup only' });
    await running;
    await save();
  }
}
console.log(`Finished: ${generationCount} generation requests; key was not logged. Revoke the temporary key.`);
