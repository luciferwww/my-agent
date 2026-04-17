/**
 * RuntimeApp live integration test.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=your-key ANTHROPIC_BASE_URL=http://localhost:5000 MY_AGENT_MODEL=gpt-4.1 \
 *   npx tsx scripts/test-runtime-app.ts
 *
 * 本脚本会：
 *   Turn 1-3  : 基础对话 + 历史验证 + context reload
 *   Turn 4    : 工具调用 — 列出 .agent/ 目录文件
 *   Turn 5    : 工具调用 — 读取指定文件内容
 *   Turn 6    : 大 tool result — 读取 AgentRunner.ts（验证 Layer 1 路径已接入）
 *   Turn 7    : 多轮工具调用 — 列目录 + 读最小文件（多 round 场景）
 *   Compaction: 独立 app 实例，小 contextWindowTokens，跑 8 轮直到压缩触发
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';

// ── 工具函数 ──────────────────────────────────────────────────────

/**
 * 直接读 sessions.json，返回指定 sessionKey 的 compactionCount。
 * 在 RuntimeApp 对外 API 尚未暴露 compacted 字段时作为代替手段。
 */
async function getCompactionCount(workspaceDir: string, sessionKey: string): Promise<number> {
  try {
    const storePath = join(workspaceDir, '.agent', 'sessions', 'sessions.json');
    const raw = await readFile(storePath, 'utf-8');
    const store: Record<string, { compactionCount?: number }> = JSON.parse(raw);
    return store[sessionKey]?.compactionCount ?? 0;
  } catch {
    return 0;
  }
}

function printResult(label: string, text: string, toolRounds: number): void {
  console.log(`Result  : ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`);
  console.log(`Rounds  : toolRounds=${toolRounds}`);
  if (toolRounds === 0) {
    console.warn(`  ⚠ WARNING [${label}]: expected toolRounds > 0`);
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const workspaceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-workspace');
  const apiKey    = process.env.ANTHROPIC_API_KEY   ?? 'EMPTY';
  const baseURL   = process.env.ANTHROPIC_BASE_URL  ?? 'http://localhost:5000';
  const model     = process.env.MY_AGENT_MODEL      ?? 'gpt-4.1';

  console.log('\n=== RuntimeApp Integration Test ===\n');
  console.log(`Workspace : ${workspaceDir}`);
  console.log(`Model     : ${model}`);
  console.log(`Base URL  : ${baseURL}`);

  // ── 启动主 App ────────────────────────────────────────────────
  const events: string[] = [];
  const app = await RuntimeApp.create({
    workspaceDir,
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: true },
    },
    onEvent: (event) => {
      events.push(event.type);
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

  // ── Turn 1: 自我介绍 ──────────────────────────────────────────
  console.log('\n--- Turn 1: Greeting ---\n');
  const r1 = await app.runTurn({
    sessionKey: 'main',
    message: 'Hello! My name is Alice.',
    model, maxTokens: 8192, promptMode: 'full',
  });
  console.log('Result:', r1.text);

  // ── Turn 2: 历史验证 ──────────────────────────────────────────
  console.log('\n--- Turn 2: History Recall ---\n');
  const r2 = await app.runTurn({
    sessionKey: 'main',
    message: 'What is my name?',
    model, maxTokens: 64,
  });
  console.log('Result:', r2.text);
  if (!r2.text.toLowerCase().includes('alice')) {
    console.warn('  ⚠ WARNING: expected "Alice" in response');
  }

  // ── Turn 3: Context reload ─────────────────────────────────────
  console.log('\n--- Turn 3: Context Reload ---\n');
  const identityPath = join(workspaceDir, '.agent', 'IDENTITY.md');
  await writeFile(identityPath, '# Identity\nReloaded identity marker.\n', 'utf-8');
  const r3 = await app.runTurn({
    sessionKey: 'main',
    message: 'Who are you?',
    model, maxTokens: 64, reloadContextFiles: true,
  });
  console.log('Result  :', r3.text);
  console.log('Context version:', app.getState().contextVersion);

  // ── Turn 4: 工具调用 — 列目录 ──────────────────────────────────
  console.log('\n--- Turn 4: Tool Use — list .agent/ ---\n');
  const r4 = await app.runTurn({
    sessionKey: 'main',
    message: '请列出当前 workspace 的 .agent/ 目录下有哪些文件和子目录（直接子项即可）。',
    model, maxTokens: 512,
  });
  printResult('Turn4', r4.text, r4.toolRounds);

  // ── Turn 5: 工具调用 — 读文件 ─────────────────────────────────
  console.log('\n--- Turn 5: Tool Use — read file ---\n');
  const r5 = await app.runTurn({
    sessionKey: 'main',
    message: '请读取 .agent/IDENTITY.md 的完整内容，把文件里的文字告诉我。',
    model, maxTokens: 256,
  });
  printResult('Turn5', r5.text, r5.toolRounds);

  // ── Turn 6: 大 tool result — Layer 1 裁剪路径验证 ─────────────
  // AgentRunner.ts 足够大，能触发 pruneToolResults（tool_result_pruned AgentEvent）。
  // RuntimeApp 未转发 AgentEvent，故通过 toolRounds > 0 间接确认工具链路通畅。
  console.log('\n--- Turn 6: Large Tool Result (Layer 1 smoke) ---\n');
  const r6 = await app.runTurn({
    sessionKey: 'main',
    message: '请读取 src/agent-runner/AgentRunner.ts 的完整内容，然后只告诉我这个文件一共有多少行代码（只回答数字即可）。',
    model, maxTokens: 64,
  });
  printResult('Turn6', r6.text, r6.toolRounds);
  console.log('  NOTE: tool_result_pruned event (AgentEvent) not surfaced via RuntimeApp.onEvent;');
  console.log('        verify via test-agent-runner-compaction-integration.ts if needed.');

  // ── Turn 7: 多轮工具调用 ───────────────────────────────────────
  // 先列出目录，再读其中最小的文件 → 需要至少两次工具调用（toolRounds >= 2）
  console.log('\n--- Turn 7: Multi-round Tool Use ---\n');
  const r7 = await app.runTurn({
    sessionKey: 'main',
    message: '请先列出 src/agent-runner/ 目录下所有 .ts 文件（不含测试文件），'
      + '然后读取其中文件名最短的那个文件，告诉我它的主要功能是什么（一句话）。',
    model, maxTokens: 256,
  });
  printResult('Turn7', r7.text, r7.toolRounds);
  if (r7.toolRounds < 2) {
    console.warn('  ⚠ WARNING [Turn7]: expected toolRounds >= 2 (list + read), got', r7.toolRounds);
  }

  // ── 关闭主 App ────────────────────────────────────────────────
  console.log('\n--- Shutdown (main app) ---\n');
  const shutdownReport = await app.close('test complete');
  console.log('Shutdown:', JSON.stringify(shutdownReport, null, 2));

  // ── Compaction Smoke Test ─────────────────────────────────────
  // 使用小 contextWindowTokens（2000）+ 独立 session，跑多轮直到 compactionCount > 0。
  // 8 轮 × ~200 token/轮 × 1.2 safety ≈ 1920 tokens > available(1600)，预计第 7-8 轮触发。
  // 非确定性：取决于 LLM 实际回复长度，不做硬断言；触发时打印确认，未触发时注明。
  console.log('\n--- Compaction Smoke Test ---\n');
  console.log('  contextWindowTokens=2000, reserveTokens=400 → available=1600 tokens');
  console.log('  Running 8 turns; compaction expected around turn 6-8...\n');

  const compactionApp = await RuntimeApp.create({
    workspaceDir,
    envOverrides: {
      llm: { apiKey, baseURL, model, contextWindowTokens: 2000 },
      memory: { enabled: false },
      compaction: { enabled: true, reserveTokens: 400, keepRecentTurns: 1 },
    },
    onEvent: (e) => {
      if (e.type === 'warning' || e.type === 'error') {
        console.error('  [CompactionApp]', e.type, JSON.stringify(e));
      }
    },
  });

  const compactionTurns = [
    '什么是 LLM 的上下文窗口？请用 3-4 句话解释。',
    'token 估算通常用什么启发式方法？请说明原理。',
    '为什么 tool result 特别容易消耗大量 token？请举例说明。',
    '对话历史变长后 LLM 推理速度会如何变化？原因是什么？',
    '上下文压缩（context compaction）的核心思路是什么？',
    '摘要压缩和裁剪 tool result 这两种策略各有什么优缺点？',
    '如果摘要生成本身也失败了，应该怎样降级处理？',
    '总结一下我们刚才讨论的所有要点，列出最重要的 3 条。',
  ];

  let compactionTriggered = false;
  for (let i = 0; i < compactionTurns.length; i++) {
    const cr = await compactionApp.runTurn({
      sessionKey: 'compaction-test',
      message: compactionTurns[i]!,
      model,
      maxTokens: 250,
      promptMode: 'minimal',
    });
    const count = await getCompactionCount(workspaceDir, 'compaction-test');
    console.log(`  Turn ${i + 1}: toolRounds=${cr.toolRounds}, compactionCount=${count}, `
      + `reply="${cr.text.slice(0, 60).replace(/\n/g, ' ')}…"`);
    if (count > 0 && !compactionTriggered) {
      compactionTriggered = true;
      console.log(`  ✓ Compaction triggered after turn ${i + 1}!`);
    }
  }

  if (!compactionTriggered) {
    console.log('\n  NOTE: No compaction triggered in this run.');
    console.log('  Possible reasons: LLM responses were short, or system prompt larger than estimated.');
    console.log('  For deterministic compaction testing, run:');
    console.log('    npx tsx scripts/test-agent-runner-compaction-integration.ts');
  }

  await compactionApp.close();

  // ── 汇总 ──────────────────────────────────────────────────────
  console.log('\n=== Summary ===\n');
  console.log(`Events received (main app)  : ${events.length}`);
  console.log(`Turn 4 (list files)   toolRounds : ${r4.toolRounds}`);
  console.log(`Turn 5 (read file)    toolRounds : ${r5.toolRounds}`);
  console.log(`Turn 6 (large file)   toolRounds : ${r6.toolRounds}`);
  console.log(`Turn 7 (multi-step)   toolRounds : ${r7.toolRounds}`);
  console.log(`Compaction triggered            : ${compactionTriggered}`);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
