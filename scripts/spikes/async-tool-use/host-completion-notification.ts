import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const [flag, outputPath] = process.argv.slice(2);
assert(flag === '--live' && outputPath, 'Usage: --live <evidence-file>');

type Protocol = 'chat/completions' | 'responses';
interface Evidence {
  startedAt: string;
  finishedAt?: string;
  requests: Array<Record<string, unknown>>;
  scenarios: Array<Record<string, unknown>>;
}

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  requests: [],
  scenarios: [],
};
const save = (): Promise<void> => writeFile(outputPath, JSON.stringify(evidence, null, 2));
const baseURL = 'http://127.0.0.1:5000/v1';
const model = 'gpt-5.4';
let requestCount = 0;

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  assert(typeof value === 'string' && value.length > 0);
  return value;
}

async function post(
  protocol: Protocol,
  phase: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assert(++requestCount <= 6, 'Six-request budget exhausted');
  const record: Record<string, unknown> = {
    protocol,
    phase,
    startedAt: new Date().toISOString(),
    body,
  };
  evidence.requests.push(record);
  await save();
  console.log(`${record.startedAt} ${protocol} ${phase}: POST`);
  try {
    const response = await fetch(`${baseURL}/${protocol}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    });
    record.status = response.status;
    record.raw = await response.text();
    console.log(`${protocol} ${phase}: HTTP ${response.status}`);
    assert(response.ok, `HTTP ${response.status}: ${String(record.raw).slice(0, 800)}`);
    return object(JSON.parse(String(record.raw)));
  } finally {
    record.finishedAt = new Date().toISOString();
    await save();
  }
}

for (const protocol of ['chat/completions', 'responses'] as const) {
  const scenario: Record<string, unknown> = { protocol, model };
  evidence.scenarios.push(scenario);
  const prefix = [{
    role: 'user',
    content: 'Start one synthetic download task by calling start_download with {}. '
      + 'The call only submits the task; do not claim completion yet.',
  }];
  const parameters = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  };
  try {
    const launchBody: Record<string, unknown> = protocol === 'responses'
      ? {
          model,
          stream: false,
          max_output_tokens: 2048,
          input: prefix,
          tools: [{
            type: 'function',
            name: 'start_download',
            description: 'Submit one synthetic download task and return a task handle.',
            parameters,
          }],
          tool_choice: { type: 'function', name: 'start_download' },
        }
      : {
          model,
          stream: false,
          max_completion_tokens: 2048,
          messages: prefix,
          tools: [{
            type: 'function',
            function: {
              name: 'start_download',
              description: 'Submit one synthetic download task and return a task handle.',
              parameters,
            },
          }],
          tool_choice: { type: 'function', function: { name: 'start_download' } },
        };
    const launch = await post(protocol, 'launch', launchBody);
    let callId: string;
    let launchItems: unknown[];
    if (protocol === 'responses') {
      assert.equal(launch.status, 'completed');
      launchItems = array(launch.output).map(object).map(item => {
        if (item.type === 'reasoning') {
          return {
            type: 'reasoning',
            summary: item.summary,
            encrypted_content: item.encrypted_content,
          };
        }
        assert.equal(item.type, 'function_call');
        callId = string(item.call_id);
        return {
          type: 'function_call',
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        };
      });
    } else {
      const choice = object(array(launch.choices)[0]);
      assert.equal(choice.finish_reason, 'tool_calls');
      const message = object(choice.message);
      const calls = array(message.tool_calls).map(object);
      assert.equal(calls.length, 1);
      const call = calls[0];
      callId = string(call.id);
      const fn = object(call.function);
      launchItems = [{
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: [{
          id: call.id,
          type: 'function',
          function: { name: fn.name, arguments: fn.arguments },
        }],
      }];
    }
    assert(callId!);
    const taskId = `task-${protocol === 'responses' ? 'responses' : 'chat'}-123`;
    const accepted = JSON.stringify({
      status: 'accepted',
      taskId,
      message: 'Task submitted; execution continues under host supervision.',
    });
    const acceptedResult = protocol === 'responses'
      ? { type: 'function_call_output', call_id: callId, output: accepted }
      : { role: 'tool', tool_call_id: callId, content: accepted };
    const steering = {
      role: 'user',
      content: '完成后提醒我查看 xxx 数据。现在只需要确认这个提醒，不要再次调用工具。',
    };
    const acceptedHistory = [...prefix, ...launchItems, acceptedResult, steering];
    const steeringBody = protocol === 'responses'
      ? { model, stream: false, max_output_tokens: 2048, input: acceptedHistory }
      : { model, stream: false, max_completion_tokens: 2048, messages: acceptedHistory };
    const steeringResponse = await post(protocol, 'steering-after-accepted', steeringBody);
    let steeringItems: unknown[];
    if (protocol === 'responses') {
      assert.equal(steeringResponse.status, 'completed');
      steeringItems = array(steeringResponse.output).map(object).map(item => {
        if (item.type === 'reasoning') {
          return {
            type: 'reasoning',
            summary: item.summary,
            encrypted_content: item.encrypted_content,
          };
        }
        assert.equal(item.type, 'message');
        return item;
      });
    } else {
      const choice = object(array(steeringResponse.choices)[0]);
      assert.equal(choice.finish_reason, 'stop');
      const message = object(choice.message);
      steeringItems = [{ role: 'assistant', content: message.content }];
    }
    const completionNotification = {
      role: 'user',
      content: '<host_task_completion>\n'
        + JSON.stringify({
          taskId,
          tool: 'start_download',
          status: 'success',
          output: 'Synthetic download completed: exactly 7 files processed.',
        })
        + '\n</host_task_completion>\n'
        + 'This is a trusted host lifecycle notification, not a new user request. '
        + 'Continue the current turn using this result.',
    };
    const finalHistory = [
      ...acceptedHistory,
      ...steeringItems,
      completionNotification,
    ];
    const finalBody = protocol === 'responses'
      ? { model, stream: false, max_output_tokens: 2048, input: finalHistory }
      : { model, stream: false, max_completion_tokens: 2048, messages: finalHistory };
    const finalResponse = await post(protocol, 'host-completion-notification', finalBody);
    scenario.callId = callId;
    scenario.taskId = taskId;
    scenario.acceptedHistory = acceptedHistory;
    scenario.steeringResponse = steeringResponse;
    scenario.completionNotification = completionNotification;
    scenario.finalResponse = finalResponse;
    scenario.mechanism = 'accepted-tool-result-then-host-user-fragment';
    await save();
  } catch (error) {
    scenario.error = String(error);
    process.exitCode = 1;
    await save();
  }
}
evidence.finishedAt = new Date().toISOString();
await save();
console.log(`Finished ${requestCount} requests.`);
