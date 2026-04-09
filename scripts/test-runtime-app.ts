/**
 * RuntimeApp live integration test.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=your-key ANTHROPIC_BASE_URL=http://localhost:5000 MY_AGENT_MODEL=gpt-4.1 npx tsx scripts/test-runtime-app.ts
 *
 * 本脚本会：
 * 1. 创建临时 workspace，写入 .agent/IDENTITY.md
 * 2. 启动 RuntimeApp，打印事件
 * 3. 连续 runTurn，验证多轮历史
 * 4. reloadContextFiles，验证上下文热重载
 * 5. 关闭 runtime，打印 shutdown report
 */

import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';

async function main() {
  // 1. 创建临时 workspace
  const workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-app-test-'));
  const agentDir = join(workspaceDir, '.agent');
  await mkdir(agentDir, { recursive: true });
  const identityPath = join(agentDir, 'IDENTITY.md');
  await writeFile(identityPath, '# Identity\nThis is a test identity.\n', 'utf-8');

  // 2. 读取环境变量
  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
  const baseURL = process.env.ANTHROPIC_BASE_URL ?? 'http://localhost:5000';
  const model = process.env.MY_AGENT_MODEL ?? 'gpt-4.1';

  console.log('\n=== RuntimeApp Integration Test ===\n');
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Model: ${model}`);
  console.log(`Base URL: ${baseURL}`);

  // 3. 启动 runtime
  const events: any[] = [];
  const app = await RuntimeApp.create({
    workspaceDir,
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: false },
    },
    onEvent: (event) => {
      events.push(event);
      switch (event.type) {
        case 'app_start':
        case 'app_ready':
        case 'turn_start':
        case 'turn_end':
        case 'context_reload':
        case 'shutdown_start':
        case 'shutdown_end':
          console.log('[Event]', event.type, JSON.stringify(event, null, 2));
          break;
        case 'warning':
        case 'error':
          console.error('[Event]', event.type, JSON.stringify(event, null, 2));
          break;
      }
    },
  });

  // 4. 首轮对话
  console.log('\n--- First Turn ---\n');
  const result1 = await app.runTurn({
    sessionKey: 'main',
    message: 'Hello! My name is Alice.',
    model,
    maxTokens: 8192,
    promptMode: 'full',
  });
  console.log('Result:', result1.text);

  // 5. 第二轮，历史验证
  console.log('\n--- Second Turn (History) ---\n');
  const result2 = await app.runTurn({
    sessionKey: 'main',
    message: 'What is my name?',
    model,
    maxTokens: 64,
  });
  console.log('Result:', result2.text);

  // 6. reloadContextFiles 测试
  console.log('\n--- Context Reload ---\n');
  await writeFile(identityPath, '# Identity\nReloaded identity marker.\n', 'utf-8');
  await app.runTurn({
    sessionKey: 'main',
    message: 'Who are you?',
    model,
    reloadContextFiles: true,
    maxTokens: 64,
  });
  console.log('Context version after reload:', app.getState().contextVersion);

  // 7. 关闭 runtime
  console.log('\n--- Shutdown ---\n');
  const shutdownReport = await app.close('test complete');
  console.log('Shutdown report:', shutdownReport);

  // 8. 清理临时目录
  await rm(workspaceDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
