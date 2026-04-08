/**
 * Example of calling the LLM through LLMProxy.
 *
 * Usage:
 *   npx tsx scripts/test-llm-proxy.ts
 */

import { AnthropicClient } from '../src/llm-client/index.js';

const ANTHROPIC_AUTH_TOKEN = 'EMPTY'
const ANTHROPIC_BASE_URL = 'http://localhost:5000'
const MODEL = 'claude-opus-4.6-fast'

const client = new AnthropicClient({
  apiKey: ANTHROPIC_AUTH_TOKEN,
  baseURL: ANTHROPIC_BASE_URL,
});

console.log(`\n=== LLMProxy Test ===`);
console.log(`Base URL: ${ANTHROPIC_BASE_URL}`);
console.log(`Model: ${MODEL}\n`);

// Non-streaming

console.log('--- Non-Streaming Call ---\n');

const response = await client.chat({
  model: MODEL,
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 256,
});

for (const block of response.content) {
  if (block.type === 'text') {
    console.log('Reply:', block.text);
  }
}
console.log('Stop reason:', response.stopReason);
console.log('Usage:', response.usage);

// Streaming

console.log('\n--- Streaming Call ---\n');

process.stdout.write('Reply: ');
for await (const event of client.chatStream({
  model: MODEL,
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 256,
})) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'message_end':
      console.log(`\nStop reason: ${event.stopReason}`);
      console.log('Usage:', event.usage);
      break;
    case 'error':
      console.error('\nError:', event.error.message);
      break;
  }
}

console.log('\n=== Done ===\n');
