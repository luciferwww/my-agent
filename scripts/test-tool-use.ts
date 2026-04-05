/**
 * Tools 模块集成测试 — 三个场景验证 LLM 参数推理能力。
 *
 * 用法：
 *   npx tsx scripts/test-tool-use.ts
 */

import { AgentRunner } from '../src/agent-runner/index.js';
import { AnthropicClient } from '../src/llm-client/index.js';
import { SessionManager } from '../src/session/index.js';
import { SystemPromptBuilder } from '../src/prompt-builder/index.js';
import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';
import { createToolExecutor, execTool, getToolDefinitions } from '../src/tools/index.js';
import type { Tool } from '../src/tools/index.js';

const ANTHROPIC_AUTH_TOKEN = 'EMPTY';
const ANTHROPIC_BASE_URL = 'http://localhost:5000';
const MODEL = 'claude-sonnet-4-6';
const WORKSPACE_DIR = './test-workspace';

// ── 工具定义 ────────────────────────────────────────────

const tools: Tool[] = [
  execTool,
  {
    name: 'get_current_time',
    description: 'Get the current date and time. No parameters needed.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      content: `Current time: ${new Date().toISOString()}`,
    }),
  },
  {
    name: 'get_date',
    description: 'Get a date relative to today. Use offset to specify days from today (e.g., -1 for yesterday, 1 for tomorrow).',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: 'Days offset from today. -1 = yesterday, 0 = today, 1 = tomorrow.' },
      },
      required: ['offset'],
    },
    execute: async (params) => {
      const offset = Number(params.offset) || 0;
      const date = new Date();
      date.setDate(date.getDate() + offset);
      return {
        content: `Date: ${date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      };
    },
  },
  {
    name: 'get_weather',
    description: 'Get weather for a city. Optionally specify a date.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        date: { type: 'string', description: 'Date string (e.g., "tomorrow", "2026-04-03"). Optional, defaults to today.' },
      },
      required: ['city'],
    },
    execute: async (params) => {
      const city = params.city as string;
      const date = (params.date as string) || 'today';
      return {
        content: `Weather in ${city} (${date}): Sunny, 25°C, humidity 60%`,
      };
    },
  },
  {
    name: 'get_user_location',
    description: 'Get the current user\'s city/location. No parameters needed.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      content: 'User location: Shanghai, China',
    }),
  },
];

// ── 初始化 ──────────────────────────────────────────────

const llmClient = new AnthropicClient({
  apiKey: ANTHROPIC_AUTH_TOKEN,
  baseURL: ANTHROPIC_BASE_URL,
});

const sessionManager = new SessionManager(WORKSPACE_DIR);
await ensureWorkspace(WORKSPACE_DIR);
const contextFiles = await loadContextFiles(WORKSPACE_DIR);

const systemPrompt = new SystemPromptBuilder().build({
  contextFiles,
  tools: tools.map(t => ({ name: t.name, description: t.description })),
});

const toolExecutor = createToolExecutor(tools);
const toolDefinitions = getToolDefinitions(tools);

// ── 运行场景 ────────────────────────────────────────────

async function runScenario(scenarioName: string, message: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`场景: ${scenarioName}`);
  console.log(`用户: ${message}`);
  console.log('='.repeat(60));

  const sessionKey = `scenario-${Date.now()}`;
  await sessionManager.createSession(sessionKey);

  const runner = new AgentRunner({
    llmClient,
    sessionManager,
    toolExecutor,
    onEvent: (event) => {
      switch (event.type) {
        case 'llm_call':
          console.log(`\n[LLM call #${event.round}]`);
          break;
        case 'text_delta':
          process.stdout.write(event.text);
          break;
        case 'tool_use':
          console.log(`\n  🔧 tool_use: ${event.name}(${JSON.stringify(event.input)})`);
          break;
        case 'tool_result':
          console.log(`  📤 result: ${event.result.content}`);
          break;
        case 'run_end':
          console.log(`\n[done] toolRounds=${event.result.toolRounds} stopReason=${event.result.stopReason}`);
          break;
      }
    },
  });

  const result = await runner.run({
    sessionKey,
    message,
    model: MODEL,
    systemPrompt,
    tools: toolDefinitions,
    maxToolRounds: 5,
  });

  console.log(`\n--- Session 消息 ---`);
  const messages = sessionManager.getMessages(sessionKey);
  for (const msg of messages) {
    const role = msg.message.role;
    const content = typeof msg.message.content === 'string'
      ? msg.message.content
      : JSON.stringify(msg.message.content, null, 2);
    console.log(`  [${role}] ${content}`);
  }
}

// ── 执行三个场景 ────────────────────────────────────────

console.log('\n🧪 Tools 集成测试 — LLM 参数推理能力验证');
console.log(`Model: ${MODEL}`);
console.log(`Tools: ${tools.map(t => t.name).join(', ')}`);

// 场景 1：单参数，LLM 需要理解"yesterday"
await runScenario(
  '1. 单参数推理',
  'What day is yesterday?',
);

// 场景 2：多参数（含必填）
await runScenario(
  '2. 多参数推理',
  "What's the weather like tomorrow in Shanghai?",
);

// 场景 3：多步工具调用（先获取位置，再查天气）
await runScenario(
  '3. 多步工具调用',
  "What's the weather like tomorrow in my city?",
);

// 场景 4：真实命令执行
await runScenario(
  '4. exec 端到端',
  'Use the exec tool to run a command that prints the current working directory, then tell me the directory path you found.',
);

console.log('\n\n✅ 所有场景完成\n');
