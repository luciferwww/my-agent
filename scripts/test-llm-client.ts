/**
 * LLM Client integration test using a real API call.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=your-key npx tsx scripts/test-llm-client.ts
 *
 * Or use a custom baseURL, for example with a LiteLLM proxy:
 *   ANTHROPIC_API_KEY=your-key ANTHROPIC_BASE_URL=http://localhost:4000 npx tsx scripts/test-llm-client.ts
 */

import { AnthropicClient } from '../src/llm-client/index.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "EMPTY";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://localhost:5000';
const client = new AnthropicClient({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL,
});

const model = process.env.MODEL ?? 'gpt-4.1';

console.log('\n=== LLM Client Integration Test ===\n');
console.log(`Model: ${model}`);
console.log(`Base URL: ${process.env.ANTHROPIC_BASE_URL ?? '(default)'}\n`);

// Test 1: non-streaming call

console.log('--- Test 1: Non-Streaming Call (chat) ---\n');

const response = await client.chat({
  model,
  system: 'You are a helpful assistant. Reply in one sentence.',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  maxTokens: 100,
});

console.log('Response:', response.content);
console.log('Stop reason:', response.stopReason);
console.log('Usage:', response.usage);

// Test 2: streaming call

console.log('\n--- Test 2: Streaming Call (chatStream) ---\n');

process.stdout.write('Streaming: ');
for await (const event of client.chatStream({
  model,
  system: 'You are a helpful assistant. Reply in one sentence.',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  maxTokens: 100,
})) {
  switch (event.type) {
    case 'message_start':
      process.stdout.write('[START] ');
      break;
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'message_end':
      console.log(` [END] (${event.stopReason}, in=${event.usage.inputTokens}, out=${event.usage.outputTokens})`);
      break;
    case 'error':
      console.error('\nError:', event.error.message);
      break;
  }
}

// Test 3: multi-turn conversation

console.log('\n--- Test 3: Multi-Turn Conversation ---\n');

const multiTurnResponse = await client.chat({
  model,
  messages: [
    { role: 'user', content: 'My name is Alice.' },
    { role: 'assistant', content: 'Nice to meet you, Alice!' },
    { role: 'user', content: 'What is my name?' },
  ],
  maxTokens: 100,
});

console.log('Response:', multiTurnResponse.content);

console.log('\n=== Test Complete ===\n');
