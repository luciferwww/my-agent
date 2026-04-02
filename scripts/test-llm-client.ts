/**
 * LLM Client 集成测试 — 真实 API 调用。
 *
 * 用法：
 *   ANTHROPIC_API_KEY=your-key npx tsx scripts/test-llm-client.ts
 *
 * 或者使用自定义 baseURL（如 LiteLLM Proxy）：
 *   ANTHROPIC_API_KEY=your-key ANTHROPIC_BASE_URL=http://localhost:4000 npx tsx scripts/test-llm-client.ts
 */

import { AnthropicClient } from '../src/llm-client/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('请设置 ANTHROPIC_API_KEY 环境变量');
  process.exit(1);
}

const client = new AnthropicClient({
  apiKey,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});

const model = process.env.MODEL ?? 'claude-sonnet-4-6';

console.log('\n=== LLM Client 集成测试 ===\n');
console.log(`Model: ${model}`);
console.log(`Base URL: ${process.env.ANTHROPIC_BASE_URL ?? '(default)'}\n`);

// ── 测试 1：非流式调用 ───────────────────────────────────

console.log('--- 测试 1：非流式调用（chat） ---\n');

const response = await client.chat({
  model,
  system: 'You are a helpful assistant. Reply in one sentence.',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  maxTokens: 100,
});

console.log('Response:', response.content);
console.log('Stop reason:', response.stopReason);
console.log('Usage:', response.usage);

// ── 测试 2：流式调用 ────────────────────────────────────

console.log('\n--- 测试 2：流式调用（chatStream） ---\n');

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

// ── 测试 3：多轮对话 ────────────────────────────────────

console.log('\n--- 测试 3：多轮对话 ---\n');

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

console.log('\n=== 测试完成 ===\n');
