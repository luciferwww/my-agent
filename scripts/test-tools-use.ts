/**
 * Tools module integration test.
 * Verifies LLM parameter inference across several scenarios.
 *
 * Usage:
 *   npx tsx scripts/test-tool-use.ts
 */

import { AgentRunner } from '../src/agent-runner/index.js';
import { AnthropicClient } from '../src/llm-client/index.js';
import { SessionManager } from '../src/session/index.js';
import { SystemPromptBuilder } from '../src/prompt-builder/index.js';
import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';
import { createToolExecutor, execTool, getToolDefinitions } from '../src/tools/index.js';
import type { Tool } from '../src/tools/index.js';

const ANTHROPIC_API_KEY = 'EMPTY';
const ANTHROPIC_BASE_URL = 'http://localhost:5000';
const MODEL = 'claude-sonnet-4-6';
const WORKSPACE_DIR = './test-workspace';

// Tool definitions

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

// Initialization

const llmClient = new AnthropicClient({
  apiKey: ANTHROPIC_API_KEY,
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

// Scenarios

async function runScenario(scenarioName: string, message: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Scenario: ${scenarioName}`);
  console.log(`User: ${message}`);
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

  console.log(`\n--- Session Messages ---`);
  const messages = sessionManager.getMessages(sessionKey);
  for (const msg of messages) {
    const role = msg.message.role;
    const content = typeof msg.message.content === 'string'
      ? msg.message.content
      : JSON.stringify(msg.message.content, null, 2);
    console.log(`  [${role}] ${content}`);
  }
}

// Execute the scenarios

console.log('\n🧪 Tools integration test — LLM parameter inference');
console.log(`Model: ${MODEL}`);
console.log(`Tools: ${tools.map(t => t.name).join(', ')}`);

// Scenario 1: single-parameter inference
await runScenario(
  '1. Single-parameter inference',
  'What day is yesterday?',
);

// Scenario 2: multi-parameter inference
await runScenario(
  '2. Multi-parameter inference',
  "What's the weather like tomorrow in Shanghai?",
);

// Scenario 3: multi-step tool use
await runScenario(
  '3. Multi-step tool use',
  "What's the weather like tomorrow in my city?",
);

// Scenario 4: real command execution
await runScenario(
  '4. exec end-to-end',
  'Use the exec tool to run a command that prints the current working directory, then tell me the directory path you found.',
);

console.log('\n\n✅ All scenarios completed\n');
