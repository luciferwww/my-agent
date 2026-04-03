/**
 * Agent Runner + Dummy Tool Executor 测试。
 * 让 LLM 调用工具，验证 tool use loop 是否正常工作。
 *
 * 用法：
 *   npx tsx scripts/test-tool-use.ts
 */

import { AgentRunner } from '../src/agent-runner/index.js';
import { AnthropicClient } from '../src/llm-client/index.js';
import { SessionManager } from '../src/session/index.js';
import { SystemPromptBuilder } from '../src/prompt-builder/index.js';
import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';

const ANTHROPIC_AUTH_TOKEN = 'EMPTY';
const ANTHROPIC_BASE_URL = 'http://localhost:5000';
const MODEL = 'claude-sonnet-4-6';
const WORKSPACE_DIR = './test-workspace';

// ── 初始化 ──────────────────────────────────────────────

const llmClient = new AnthropicClient({
  apiKey: ANTHROPIC_AUTH_TOKEN,
  baseURL: ANTHROPIC_BASE_URL,
});

const sessionManager = new SessionManager(WORKSPACE_DIR);
await ensureWorkspace(WORKSPACE_DIR);
const contextFiles = await loadContextFiles(WORKSPACE_DIR);

// 定义工具
const tools = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city. Returns temperature and conditions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
  },
  {
    name: 'get_time',
    description: 'Get current time for a timezone.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: { type: 'string', description: 'Timezone, e.g. Asia/Tokyo' },
      },
      required: ['timezone'],
    },
  },
];

// 构建 System Prompt（包含工具定义）
const systemPrompt = new SystemPromptBuilder().build({
  contextFiles,
  tools: tools.map(t => ({ name: t.name, description: t.description })),
});

// Dummy Tool Executor
const toolExecutor = async (toolName: string, input: Record<string, unknown>) => {
  console.log(`\n  🔧 [${toolName}] input: ${JSON.stringify(input)}`);

  switch (toolName) {
    case 'get_weather': {
      const city = input.city as string ?? 'unknown';
      const result = `Weather in ${city}: Sunny, 25°C, humidity 60%`;
      console.log(`  📤 result: ${result}`);
      return { content: result };
    }
    case 'get_time': {
      const tz = input.timezone as string ?? 'UTC';
      const result = `Current time in ${tz}: ${new Date().toLocaleString('en-US', { timeZone: tz })}`;
      console.log(`  📤 result: ${result}`);
      return { content: result };
    }
    default:
      return { content: `Unknown tool: ${toolName}`, isError: true };
  }
};

// ── 创建 Runner ─────────────────────────────────────────

const runner = new AgentRunner({
  llmClient,
  sessionManager,
  toolExecutor,
  onEvent: (event) => {
    switch (event.type) {
      case 'run_start':
        console.log('\n[run_start]');
        break;
      case 'llm_call':
        console.log(`[llm_call] round=${event.round}`);
        break;
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_use':
        console.log(`\n[tool_use] ${event.name}`);
        break;
      case 'tool_result':
        console.log(`[tool_result] ${event.name} → ${event.result.content.slice(0, 60)}`);
        break;
      case 'run_end':
        console.log(`\n[run_end] stopReason=${event.result.stopReason} toolRounds=${event.result.toolRounds}`);
        console.log(`[usage] in=${event.result.usage.inputTokens} out=${event.result.usage.outputTokens}`);
        break;
      case 'error':
        console.error(`[error] ${event.error.message}`);
        break;
    }
  },
});

// ── 运行 ────────────────────────────────────────────────

const { entry } = await sessionManager.resolveSession('tool-test');

console.log('=== Tool Use 测试 ===');
console.log(`Model: ${MODEL}`);
console.log(`Session: ${entry.sessionId}`);
console.log(`Tools: ${tools.map(t => t.name).join(', ')}`);
console.log(`maxToolRounds: 5`);

const result = await runner.run({
  sessionKey: 'tool-test',
  message: 'What is the weather in Tokyo and what time is it there?',
  model: MODEL,
  systemPrompt,
  tools,
  maxToolRounds: 5,
});

console.log('\n--- 最终结果 ---');
console.log(`Text: ${result.text}`);
console.log(`Tool rounds: ${result.toolRounds}`);

console.log('\n--- Session 消息 ---');
const messages = sessionManager.getMessages('tool-test');
for (const msg of messages) {
  const role = msg.message.role;
  const content = typeof msg.message.content === 'string'
    ? msg.message.content
    : JSON.stringify(msg.message.content).slice(0, 100) + '...';
  console.log(`  [${role}] ${content}`);
}
console.log(`\n总消息数: ${messages.length}`);
console.log('\n=== 完成 ===\n');
