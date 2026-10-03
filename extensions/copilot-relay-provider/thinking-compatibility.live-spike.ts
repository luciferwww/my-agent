import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit opt-in experiment, not a production compatibility policy or automatic test.
export type Protocol = 'chat' | 'responses';
type WireRecord = Record<string, unknown>;
type Outcome = {
  label: string;
  model: string;
  httpStatus: number | null;
  failure?: 'transport' | 'invalid_json' | 'invalid_shape';
  errorMentionsReplay?: boolean;
  terminal?: string;
  answerMatches?: boolean;
  visibleTextLength?: number;
  opaqueCount?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

class SpikeError extends Error {}

function object(value: unknown): WireRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SpikeError('invalid_object');
  }
  return value as WireRecord;
}

function records(value: unknown): WireRecord[] {
  if (!Array.isArray(value)) throw new SpikeError('invalid_array');
  return value.map(object);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new SpikeError('invalid_string');
  return value;
}

function assistant(protocol: Protocol, body: WireRecord): WireRecord[] {
  return protocol === 'chat'
    ? [object(records(body.choices)[0]?.message)]
    : records(body.output);
}

function opaqueKey(protocol: Protocol): string {
  return protocol === 'chat' ? 'reasoning_opaque' : 'encrypted_content';
}

export function opaqueCount(protocol: Protocol, history: WireRecord[]): number {
  const key = opaqueKey(protocol);
  return history.filter(item =>
    (protocol === 'chat' ? item.role === 'assistant' : item.type === 'reasoning')
    && typeof item[key] === 'string' && item[key].length > 0,
  ).length;
}

export function replayVariants(protocol: Protocol, history: WireRecord[]) {
  if (opaqueCount(protocol, history) === 0) throw new SpikeError('seed_has_no_opaque');
  const original = structuredClone(history);
  const omitted = structuredClone(history);
  const corrupted = structuredClone(history);
  const key = opaqueKey(protocol);
  for (const item of omitted) {
    if (protocol === 'chat' ? item.role === 'assistant' : item.type === 'reasoning') {
      delete item[key];
    }
  }
  for (const item of corrupted) {
    if (!(protocol === 'chat' ? item.role === 'assistant' : item.type === 'reasoning')) continue;
    const value = item[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const index = Math.floor(value.length / 2);
    item[key] = value.slice(0, index) + (value[index] === 'A' ? 'B' : 'A') + value.slice(index + 1);
  }
  return { original, omitted, corrupted };
}

function visibleText(protocol: Protocol, body: WireRecord): string {
  const items = assistant(protocol, body);
  if (protocol === 'chat') return items[0].content == null ? '' : text(items[0].content);
  return items.filter(item => item.type === 'message')
    .flatMap(item => records(item.content))
    .filter(part => part.type === 'output_text')
    .map(part => text(part.text)).join('');
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function summarize(
  protocol: Protocol, body: WireRecord, expected: string,
): Omit<Outcome, 'label' | 'model' | 'httpStatus'> {
  const value = protocol === 'chat' ? records(body.choices)[0]?.finish_reason : body.status;
  const terminal = ['stop', 'tool_calls', 'length', 'completed', 'incomplete', 'failed']
    .find(candidate => candidate === value) ?? 'other';
  const visible = visibleText(protocol, body);
  const usage = body.usage == null ? {} : object(body.usage);
  return {
    terminal,
    answerMatches: visible.trim() === expected,
    visibleTextLength: visible.length,
    opaqueCount: opaqueCount(protocol, assistant(protocol, body)),
    inputTokens: tokenCount(protocol === 'chat' ? usage.prompt_tokens : usage.input_tokens),
    outputTokens: tokenCount(protocol === 'chat' ? usage.completion_tokens : usage.output_tokens),
  };
}

export function errorMentionsReplay(body: WireRecord): boolean {
  const error = body.error;
  const message = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && !Array.isArray(error)
      ? object(error).message : body.message;
  return typeof message === 'string' && /reasoning|encrypt|decrypt|opaque|signature/i.test(message);
}

const parameters = {
  type: 'object',
  properties: { n: { type: 'integer' } },
  required: ['n'],
  additionalProperties: false,
};
const prompt = 'Call fixture_value with n=7 exactly once. After its result, reply with only the returned integer.';

function request(protocol: Protocol, model: string, history: WireRecord[], seed: boolean) {
  const tool = { name: 'fixture_value', description: 'Returns the given integer without side effects.', parameters };
  return protocol === 'chat' ? {
    model, stream: false, messages: history, max_tokens: 512,
    tools: [{ type: 'function', function: tool }],
    tool_choice: seed ? { type: 'function', function: { name: tool.name } } : 'none',
  } : {
    model, stream: false, input: history, max_output_tokens: 512,
    tools: [{ type: 'function', ...tool }],
    tool_choice: seed ? { type: 'function', name: tool.name } : 'none',
  };
}

function seedHistory(protocol: Protocol, initial: WireRecord[], body: WireRecord): WireRecord[] {
  const items = assistant(protocol, body);
  const calls = protocol === 'chat'
    ? records(items[0].tool_calls) : items.filter(item => item.type === 'function_call');
  if (calls.length !== 1) throw new SpikeError('seed_expected_one_tool');
  const call = calls[0];
  const fn = protocol === 'chat' ? object(call.function) : call;
  let args: WireRecord;
  try {
    const parsed: unknown = JSON.parse(text(fn.arguments));
    args = object(parsed);
  } catch {
    throw new SpikeError('seed_invalid_tool_arguments');
  }
  if (fn.name !== 'fixture_value' || args.n !== 7 || Object.keys(args).length !== 1) {
    throw new SpikeError('seed_unexpected_tool_arguments');
  }
  const result = protocol === 'chat'
    ? { role: 'tool', tool_call_id: text(call.id), content: '7' }
    : { type: 'function_call_output', call_id: text(call.call_id), output: '7' };
  const history = [...initial, ...items, result];
  if (opaqueCount(protocol, history) === 0) throw new SpikeError('seed_has_no_opaque');
  return history;
}

export async function runLive(reportPath: string): Promise<void> {
  const report = await open(reportPath, 'wx');
  const outcomes: Outcome[] = [];
  const protocolFailures: { protocol: Protocol; reason: string }[] = [];
  const skipped: { protocol: Protocol; reason: string }[] = [];
  let count = 0;
  let incomplete = false;
  async function send(
    protocol: Protocol, model: string, label: string, history: WireRecord[], expected: string, seed = false,
  ): Promise<{ body?: WireRecord; outcome: Outcome }> {
    if (count >= 12) throw new SpikeError('request_limit_exceeded');
    count += 1;
    const outcome: Outcome = { label, model, httpStatus: null };
    outcomes.push(outcome);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:5000/v1/${protocol === 'chat' ? 'chat/completions' : 'responses'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request(protocol, model, history, seed)),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      outcome.failure = 'transport';
      incomplete = true;
      console.log(JSON.stringify(outcome));
      return { outcome };
    }
    outcome.httpStatus = response.status;
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      outcome.failure = 'invalid_json';
      incomplete = true;
      console.log(JSON.stringify(outcome));
      return { outcome };
    }
    try {
      const body = object(parsed);
      if (!response.ok) {
        outcome.errorMentionsReplay = errorMentionsReplay(body);
        console.log(JSON.stringify(outcome));
        return { outcome };
      }
      Object.assign(outcome, summarize(protocol, body, expected));
      console.log(JSON.stringify(outcome));
      return { body, outcome };
    } catch {
      outcome.failure = 'invalid_shape';
      incomplete = true;
      console.log(JSON.stringify(outcome));
      return { outcome };
    }
  }

  const pairs: { protocol: Protocol; source: string; target: string }[] = [
    { protocol: 'chat', source: 'gemini-3.5-flash', target: 'gemini-3.6-flash' },
    { protocol: 'responses', source: 'gpt-5.4-mini', target: 'gpt-5-mini' },
  ];
  try {
    for (const { protocol, source, target } of pairs) {
      try {
        const initial = [{ role: 'user', content: prompt }];
        const seed = await send(protocol, source, `${protocol}:seed`, initial, '', true);
        if (!seed.body || seed.outcome.terminal !== (protocol === 'chat' ? 'tool_calls' : 'completed')) {
          throw new SpikeError('seed_not_complete');
        }
        const history = seedHistory(protocol, initial, seed.body);
        const variants = replayVariants(protocol, history);
        const baseline = await send(protocol, source, `${protocol}:same-model`, variants.original, '7');
        if (!baseline.body || !baseline.outcome.answerMatches
          || baseline.outcome.terminal !== (protocol === 'chat' ? 'stop' : 'completed')) {
          throw new SpikeError('baseline_not_complete');
        }
        const changed = await send(protocol, target, `${protocol}:changed-model-active-chain`, variants.original, '7');
        const changedCompleted = changed.outcome.answerMatches
          && changed.outcome.terminal === (protocol === 'chat' ? 'stop' : 'completed');
        if (!changedCompleted) {
          await send(protocol, target, `${protocol}:target-clean-control`,
            [{ role: 'user', content: 'Reply with only 7.' }], '7');
        }
        await send(protocol, source, `${protocol}:omitted-opaque`, variants.omitted, '7');
        await send(protocol, source, `${protocol}:corrupted-opaque`, variants.corrupted, '7');
        const completedHistory = [
          ...history, ...assistant(protocol, baseline.body),
          { role: 'user', content: 'This is a new turn. Reply with only 8.' },
        ];
        if (changedCompleted) {
          await send(protocol, target, `${protocol}:changed-model-completed-turn`, completedHistory, '8');
        } else {
          skipped.push({ protocol, reason: 'completed-turn case replaced by target-clean control within six-request budget' });
        }
      } catch (error) {
        incomplete = true;
        const failure = { protocol, reason: error instanceof SpikeError ? error.message : 'unexpected_local_failure' };
        protocolFailures.push(failure);
        console.log(JSON.stringify(failure));
      }
    }
  } finally {
    try {
      await report.writeFile(JSON.stringify({
        executedAt: new Date().toISOString(),
        endpoint: 'http://127.0.0.1:5000/v1',
        outputLimitPerRequest: 512,
        thinkingControls: 'omitted',
        rawStatePersistence: 'none; in-memory only',
        requestCount: count, incomplete, protocolFailures, skipped, outcomes,
      }, null, 2) + '\n', 'utf8');
    } finally {
      await report.close();
    }
  }
  if (incomplete) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--execute' || args[1] !== '--report') {
    console.error('No requests sent. Usage: tsx thinking-compatibility.live-spike.ts --execute --report <new-summary.json>');
    process.exitCode = 1;
  } else {
    await runLive(args[2]);
  }
}
