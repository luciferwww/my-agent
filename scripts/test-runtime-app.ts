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

import { writeFile } from 'fs/promises';
// import { mkdtemp, rm } from 'fs/promises';
// import { tmpdir } from 'os';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';

async function main() {
  // 1. 使用固定 workspace（保留历史和记忆，更接近真实 agent 工作环境）
  //    原代码：const workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-app-test-'));
  //    .agent/ 目录和模板文件（IDENTITY.md 等）由 ensureWorkspace() 自动创建
  const workspaceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-workspace');

  // 2. 读取环境变量
  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
  const baseURL = process.env.ANTHROPIC_BASE_URL ?? 'http://localhost:5000';
  const model = process.env.MY_AGENT_MODEL ?? 'gpt-4.1';

  console.log('\n=== RuntimeApp Integration Test ===\n');
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Model: ${model}`);
  console.log(`Base URL: ${baseURL}`);
  console.log(`Memory Enabled: true`);


  // 3. 启动 runtime
  const events: any[] = [];
  const app = await RuntimeApp.create({
    workspaceDir,
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: true },
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
  const identityPath = join(workspaceDir, '.agent', 'IDENTITY.md');
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

  // 8. 固定 workspace，不再清理（保留历史和记忆）
  //    原代码：await rm(workspaceDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
