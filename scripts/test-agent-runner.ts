/**
 * Agent Runner integration test.
 * Wires all modules together to complete a real conversation.
 *
 * Usage:
 *   npx tsx scripts/test-agent-runner.ts
 */

import { AgentRunner } from '../src/agent-runner/index.js';
import { AnthropicClient } from '../src/llm-client/index.js';
import { SessionManager } from '../src/session/index.js';
import { SystemPromptBuilder } from '../src/prompt-builder/index.js';
import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';

const ANTHROPIC_API_KEY = 'EMPTY';
const ANTHROPIC_BASE_URL = 'http://localhost:5000';
const MODEL = 'claude-sonnet-4-6';
const WORKSPACE_DIR = './test-workspace';

console.log('\n=== Agent Runner Integration Test ===\n');
console.log(`Model: ${MODEL}`);
console.log(`Base URL: ${ANTHROPIC_BASE_URL}`);
console.log(`maxToolRounds: 2`);
console.log(`maxFollowUpRounds: 2\n`);

// 1. Initialize all modules

const llmClient = new AnthropicClient({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL,
});

const sessionManager = new SessionManager(WORKSPACE_DIR);

// Initialize the workspace and load context files.
await ensureWorkspace(WORKSPACE_DIR);
const contextFiles = await loadContextFiles(WORKSPACE_DIR);
console.log(`Loaded ${contextFiles.length} context files\n`);

// Build the system prompt.
const systemPrompt = new SystemPromptBuilder().build({ contextFiles });

// Resolve or create the session.
const { entry: sessionEntry, isNew } = await sessionManager.resolveSession('main');
console.log(`Session: ${sessionEntry.sessionId} (${isNew ? 'new' : 'existing'})\n`);

// Create AgentRunner with a dummy tool executor and event callback.
const runner = new AgentRunner({
  llmClient,
  sessionManager,
  toolExecutor: async (toolName, input) => {
    console.log(`\n  [Tool] ${toolName}(${JSON.stringify(input)})`);
    return { content: `Dummy result for ${toolName}: success` };
  },
  onEvent: (event) => {
    switch (event.type) {
      case 'run_start':
        console.log('[Event] run_start');
        break;
      case 'llm_call':
        console.log(`[Event] llm_call round=${event.round}`);
        break;
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_use':
        console.log(`\n[Event] tool_use: ${event.name}`);
        break;
      case 'tool_result':
        console.log(`[Event] tool_result: ${event.name} → ${event.result.content}`);
        break;
      case 'run_end':
        console.log(`\n[Event] run_end (stopReason=${event.result.stopReason}, toolRounds=${event.result.toolRounds})`);
        break;
      case 'error':
        console.error(`[Event] error: ${event.error.message}`);
        break;
    }
  },
});

// 2. First turn

console.log('--- First Turn ---\n');

const result1 = await runner.run({
  sessionKey: 'main',
  message: 'Hello! My name is Alice.',
  model: MODEL,
  systemPrompt,
  maxToolRounds: 2,
  maxFollowUpRounds: 2,
});

console.log(`\nUsage: in=${result1.usage.inputTokens} out=${result1.usage.outputTokens}`);

// 3. Second turn, validating multi-turn history

console.log('\n--- Second Turn (History Validation) ---\n');

const result2 = await runner.run({
  sessionKey: 'main',
  message: 'What is my name?',
  model: MODEL,
  systemPrompt,
  maxToolRounds: 2,
  maxFollowUpRounds: 2,
});

console.log(`\nUsage: in=${result2.usage.inputTokens} out=${result2.usage.outputTokens}`);

// 4. Inspect session messages

console.log('\n--- Session Messages ---\n');

const messages = sessionManager.getMessages('main');
for (const msg of messages) {
  const role = msg.message.role;
  const content = typeof msg.message.content === 'string'
    ? msg.message.content
    : JSON.stringify(msg.message.content, null, 2);
  console.log(`  [${role}] ${content}`);
}

console.log(`\nTotal messages: ${messages.length}`);
console.log('\n=== Done ===\n');
