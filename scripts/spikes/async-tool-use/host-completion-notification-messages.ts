import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [flag, keyPath, outputPath] = process.argv.slice(2);
assert(flag === '--live' && keyPath && outputPath, 'Usage: --live <key-file> <evidence-file>');
const apiKey = (await readFile(keyPath, 'utf8')).trim();
assert(apiKey && !/\s/.test(apiKey), 'Invalid temporary credential');
const redact = (value: string): string => value.split(apiKey).join('[REDACTED]');
const evidence: {
  startedAt: string;
  finishedAt?: string;
  requests: Array<Record<string, unknown>>;
  scenario: Record<string, unknown>;
} = {
  startedAt: new Date().toISOString(),
  requests: [],
  scenario: {
    protocol: 'messages',
    provider: 'siliconflow',
    model: 'zai-org/GLM-5.3',
  },
};
const save = (): Promise<void> =>
  writeFile(outputPath, redact(JSON.stringify(evidence, null, 2)));
let count = 0;

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

async function post(phase: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  assert(++count <= 3, 'Three-request budget exhausted');
  const record: Record<string, unknown> = {
    phase,
    startedAt: new Date().toISOString(),
    body,
  };
  evidence.requests.push(record);
  await save();
  console.log(`${record.startedAt} messages ${phase}: POST`);
  try {
    const response = await fetch('https://api.siliconflow.cn/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    });
    record.status = response.status;
    record.raw = await response.text();
    console.log(`messages ${phase}: HTTP ${response.status}`);
    assert(response.ok, `HTTP ${response.status}: ${String(record.raw).slice(0, 800)}`);
    return object(JSON.parse(String(record.raw)));
  } finally {
    record.finishedAt = new Date().toISOString();
    await save();
  }
}

try {
  const model = 'zai-org/GLM-5.3';
  const prefix = [{
    role: 'user',
    content: 'Start one synthetic download task by calling start_download with {}. '
      + 'The call only submits the task; do not claim completion yet.',
  }];
  const launch = await post('launch', {
    model,
    max_tokens: 2048,
    stream: false,
    messages: prefix,
    tools: [{
      name: 'start_download',
      description: 'Submit one synthetic download task and return a task handle.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: 'tool', name: 'start_download' },
  });
  assert.equal(launch.stop_reason, 'tool_use');
  const launchContent = array(launch.content).map(object);
  const calls = launchContent.filter(block => block.type === 'tool_use');
  assert.equal(calls.length, 1);
  const callId = string(calls[0].id);
  const taskId = 'task-messages-123';
  const accepted = JSON.stringify({
    status: 'accepted',
    taskId,
    message: 'Task submitted; execution continues under host supervision.',
  });
  // Anthropic-compatible Messages requires the tool_result in the next user message.
  // The steering text follows it in the same message, preserving a legal closed pair.
  const steeringHistory = [
    ...prefix,
    { role: 'assistant', content: launchContent },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: callId, content: accepted },
        {
          type: 'text',
          text: '完成后提醒我查看 xxx 数据。现在只需要确认这个提醒，不要再次调用工具。',
        },
      ],
    },
  ];
  const steering = await post('steering-after-accepted', {
    model,
    max_tokens: 2048,
    stream: false,
    messages: steeringHistory,
  });
  assert.equal(steering.stop_reason, 'end_turn');
  const steeringContent = array(steering.content).map(object);
  assert.equal(steeringContent.filter(block => block.type === 'tool_use').length, 0);
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
  const final = await post('host-completion-notification', {
    model,
    max_tokens: 2048,
    stream: false,
    messages: [
      ...steeringHistory,
      { role: 'assistant', content: steeringContent },
      completionNotification,
    ],
  });
  assert.equal(final.stop_reason, 'end_turn');
  evidence.scenario = {
    ...evidence.scenario,
    callId,
    taskId,
    acceptedHistory: steeringHistory,
    steeringResponse: steering,
    completionNotification,
    finalResponse: final,
    mechanism: 'accepted-tool-result-then-host-user-fragment',
  };
} catch (error) {
  evidence.scenario.error = redact(String(error));
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await save();
}
console.log(`Finished ${count} requests; temporary credential was not logged.`);
