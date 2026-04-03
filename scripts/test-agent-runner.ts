/**
 * Agent Runner 集成测试 — 串联所有模块完成一次真实对话。
 *
 * 用法：
 *   npx tsx scripts/test-agent-runner.ts
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

console.log('\n=== Agent Runner 集成测试 ===\n');
console.log(`Model: ${MODEL}`);
console.log(`Base URL: ${ANTHROPIC_BASE_URL}`);
console.log(`maxToolRounds: 2`);
console.log(`maxFollowUpRounds: 2\n`);

// ── 1. 初始化所有模块 ───────────────────────────────────

const llmClient = new AnthropicClient({
  apiKey: ANTHROPIC_AUTH_TOKEN,
  baseURL: ANTHROPIC_BASE_URL,
});

const sessionManager = new SessionManager(WORKSPACE_DIR);

// 初始化工作区 + 加载上下文文件
await ensureWorkspace(WORKSPACE_DIR);
const contextFiles = await loadContextFiles(WORKSPACE_DIR);
console.log(`加载了 ${contextFiles.length} 个上下文文件\n`);

// 构建 System Prompt
const systemPrompt = new SystemPromptBuilder().build({ contextFiles });

// 获取或创建 Session
const { entry: sessionEntry, isNew } = await sessionManager.resolveSession('main');
console.log(`Session: ${sessionEntry.sessionId} (${isNew ? '新建' : '已有'})\n`);

// 创建 AgentRunner（带 dummy tool executor + 事件回调）
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

// ── 2. 第一轮对话 ───────────────────────────────────────

console.log('--- 第一轮对话 ---\n');

const result1 = await runner.run({
  sessionKey: 'main',
  message: 'Hello! My name is Alice.',
  model: MODEL,
  systemPrompt,
  maxToolRounds: 2,
  maxFollowUpRounds: 2,
});

console.log(`\nUsage: in=${result1.usage.inputTokens} out=${result1.usage.outputTokens}`);

// ── 3. 第二轮对话（验证多轮历史） ────────────────────────

console.log('\n--- 第二轮对话（验证历史） ---\n');

const result2 = await runner.run({
  sessionKey: 'main',
  message: 'What is my name?',
  model: MODEL,
  systemPrompt,
  maxToolRounds: 2,
  maxFollowUpRounds: 2,
});

console.log(`\nUsage: in=${result2.usage.inputTokens} out=${result2.usage.outputTokens}`);

// ── 4. 查看 Session 中的消息 ────────────────────────────

console.log('\n--- Session 消息 ---\n');

const messages = sessionManager.getMessages('main');
for (const msg of messages) {
  const role = msg.message.role;
  const content = typeof msg.message.content === 'string'
    ? msg.message.content
    : JSON.stringify(msg.message.content).slice(0, 80) + '...';
  console.log(`  [${role}] ${content}`);
}

console.log(`\n总消息数: ${messages.length}`);
console.log('\n=== 完成 ===\n');
