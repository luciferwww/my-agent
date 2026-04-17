/**
 * AgentRunner 压缩功能集成测试。
 *
 * 验证跨模块协作链路（AgentRunner + SessionManager + compaction），
 * 覆盖三条核心压缩路径：
 *
 *   Path 1 — LLM API overflow：LLM 返回 context overflow 错误，触发
 *             compactHistory()，压缩记录写入 session，重试后成功。
 *   Path 2 — Preemptive compact：消息量超过上下文预算，在调用 LLM 之前
 *             主动触发压缩，重试后成功。
 *   Path 3 — MAX_COMPACTION_RETRIES 超限：LLM 持续报错，超过最大重试次数
 *             后向上抛出 ContextOverflowError。
 *
 * 使用真实 SessionManager（tmpdir），mock LLM（顺序消费预设响应），
 * 无需 LLM API Key 或本地代理即可运行。
 *
 * Usage:
 *   npx tsx scripts/test-agent-runner-compaction-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { AgentRunner } from '../src/agent-runner/index.js';
import { ContextOverflowError } from '../src/agent-runner/errors.js';
import { SessionManager } from '../src/session/index.js';
import type { StreamEvent } from '../src/llm-client/types.js';
import type { CompactionConfig } from '../src/config/types.js';

// ── runStep 脚手架 ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runStep(name: string, step: () => Promise<void>): Promise<void> {
  console.log(`\n${'-'.repeat(72)}`);
  console.log(`STEP: ${name}`);
  console.log('-'.repeat(72));
  try {
    await step();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAILED: ${name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

// ── Mock LLM 工厂 ────────────────────────────────────────────────

/**
 * 顺序消费 mock LLM：每次调用 chatStream() 消费 responses 数组的下一个元素。
 *   - StreamEvent[]：yield 这些事件
 *   - Error：throw 这个错误（模拟 LLM API 报错）
 */
function createSequentialMockLLM(responses: Array<StreamEvent[] | Error>) {
  let callIndex = 0;
  return {
    async *chatStream(): AsyncIterable<StreamEvent> {
      const entry = responses[callIndex++];
      if (!entry) {
        throw new Error(`Mock LLM: unexpected call #${callIndex} (only ${responses.length} responses configured)`);
      }
      if (entry instanceof Error) throw entry;
      for (const event of entry) yield event;
    },
    async chat(): Promise<never> {
      throw new Error('Not used');
    },
  };
}

function textResponse(text: string): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

function summaryResponse(summary: string): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'text_delta', text: summary },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 20 } },
  ];
}

/** 触发 isContextOverflowError 匹配的 API 错误 */
function contextOverflowError(): Error {
  return new Error('request_too_large: prompt exceeds context limit');
}

// ── 测试辅助 ─────────────────────────────────────────────────────

/** keepRecentTurns=1 使每次压缩都有足够的压缩区 */
const BASE_COMPACTION: CompactionConfig = {
  enabled: true,
  reserveTokens: 1_000,
  keepRecentTurns: 1,
  toolResultContextShare: 0.5,
  toolResultHeadChars: 10_000,
  toolResultTailChars: 5_000,
  timeoutSeconds: 300,
};

/** 触发 preemptive compact 的参数（极小上下文窗口 + 大量历史消息） */
const PREEMPTIVE_COMPACTION: CompactionConfig = { ...BASE_COMPACTION, reserveTokens: 200 };
const SMALL_CONTEXT_WINDOW = 300; // available = 300 - 200 = 100 tokens

/** 向 session 预填 N 轮 user/assistant 消息 */
async function prefillHistory(manager: SessionManager, turns: number): Promise<void> {
  for (let i = 1; i <= turns; i++) {
    await manager.appendMessage('main', {
      role: 'user',
      content: `Turn ${i} user message.`,
    });
    await manager.appendMessage('main', {
      role: 'assistant',
      content: [{ type: 'text', text: `Turn ${i} assistant reply.` }],
    });
  }
}

/**
 * 向 session 预填 N 轮大内容历史消息（每条 ~200 字符），
 * 用于触发 token budget 超限（preemptive 路径）。
 *
 * Token 估算：200 chars → ceil(200/4)+4 ≈ 54 tokens/消息；
 * 4 轮（8 条）× 54 ≈ 432 raw tokens × 1.2 ≈ 520 tokens > available=100 → 超限。
 */
async function prefillLargeHistory(manager: SessionManager, turns: number): Promise<void> {
  const longContent = 'x'.repeat(200);
  for (let i = 1; i <= turns; i++) {
    await manager.appendMessage('main', {
      role: 'user',
      content: `${longContent} (turn ${i})`,
    });
    await manager.appendMessage('main', {
      role: 'assistant',
      content: [{ type: 'text', text: `${longContent} (reply ${i})` }],
    });
  }
}

// ── 入口 ─────────────────────────────────────────────────────────

console.log('\n=== AgentRunner Compaction Integration Test ===\n');

let workspaceDir = '';

try {
  workspaceDir = await mkdtemp(join(tmpdir(), 'compaction-integration-'));

  // ── Path 1：LLM API overflow → compact → retry ─────────────────

  await runStep('Path 1a: result.compacted is true after LLM API overflow', async () => {
    const manager = new SessionManager(workspaceDir + '/p1a');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    const llmClient = createSequentialMockLLM([
      contextOverflowError(),
      summaryResponse('Summary of turns 1 and 2.'),
      textResponse('Retry succeeded after compaction.'),
    ]);

    const runner = new AgentRunner({ llmClient, sessionManager: manager });
    const result = await runner.run({
      sessionKey: 'main',
      message: 'New question',
      model: 'test',
      systemPrompt: '',
      compaction: BASE_COMPACTION,
    });

    assert.ok(result.compacted === true, `expected compacted=true, got ${result.compacted}`);
    assert.equal(result.text, 'Retry succeeded after compaction.');
    console.log(`  result.text="${result.text}", compacted=${result.compacted}`);
  });

  await runStep('Path 1b: CompactionRecord persisted with correct fields', async () => {
    const manager = new SessionManager(workspaceDir + '/p1b');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    const llmClient = createSequentialMockLLM([
      contextOverflowError(),
      summaryResponse('Persisted summary.'),
      textResponse('Done.'),
    ]);

    const runner = new AgentRunner({ llmClient, sessionManager: manager });
    await runner.run({
      sessionKey: 'main',
      message: 'Hello',
      model: 'test',
      systemPrompt: '',
      compaction: BASE_COMPACTION,
    });

    const record = manager.getLastCompactionRecord('main');
    assert.ok(record !== null, 'expected CompactionRecord, got null');
    assert.equal(record!.type, 'compaction');
    assert.equal(record!.trigger, 'overflow');
    assert.equal(record!.summary, 'Persisted summary.');
    assert.ok(record!.droppedMessages > 0, `expected droppedMessages > 0, got ${record!.droppedMessages}`);
    assert.ok(record!.tokensBefore > record!.tokensAfter,
      `expected tokensBefore(${record!.tokensBefore}) > tokensAfter(${record!.tokensAfter})`);
    console.log(`  trigger=${record!.trigger}, dropped=${record!.droppedMessages}, before=${record!.tokensBefore}, after=${record!.tokensAfter}`);
  });

  await runStep('Path 1c: compaction_start / compaction_end events emitted', async () => {
    const manager = new SessionManager(workspaceDir + '/p1c');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    const llmClient = createSequentialMockLLM([
      contextOverflowError(),
      summaryResponse('Event summary.'),
      textResponse('Done.'),
    ]);

    const eventTypes: string[] = [];
    const runner = new AgentRunner({
      llmClient,
      sessionManager: manager,
      onEvent: (e) => {
        eventTypes.push(e.type);
        if (e.type === 'compaction_start') {
          console.log(`  compaction_start: trigger=${e.trigger}, tokensBefore=${e.tokensBefore}`);
        }
        if (e.type === 'compaction_end') {
          console.log(`  compaction_end: before=${e.tokensBefore}, after=${e.tokensAfter}, dropped=${e.droppedMessages}`);
        }
      },
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Hello',
      model: 'test',
      systemPrompt: '',
      compaction: BASE_COMPACTION,
    });

    assert.ok(eventTypes.includes('compaction_start'), 'compaction_start event not emitted');
    assert.ok(eventTypes.includes('compaction_end'), 'compaction_end event not emitted');
  });

  await runStep('Path 1d: fallback summary used when generateSummary LLM call fails', async () => {
    const manager = new SessionManager(workspaceDir + '/p1d');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    const llmClient = createSequentialMockLLM([
      contextOverflowError(),
      new Error('LLM service temporarily unavailable'), // generateSummary 抛错 → 兜底
      textResponse('Done.'),
    ]);

    const runner = new AgentRunner({ llmClient, sessionManager: manager });
    const result = await runner.run({
      sessionKey: 'main',
      message: 'Hello',
      model: 'test',
      systemPrompt: '',
      compaction: BASE_COMPACTION,
    });

    const record = manager.getLastCompactionRecord('main');
    assert.ok(record !== null, 'expected CompactionRecord, got null');
    assert.ok(
      record!.summary.includes('[Conversation summary unavailable'),
      `expected fallback summary, got: "${record!.summary}"`,
    );
    assert.ok(result.compacted === true);
    console.log(`  fallback summary: "${record!.summary.slice(0, 80)}..."`);
  });

  // ── Path 2：Preemptive compact ──────────────────────────────────

  await runStep('Path 2a: preemptive compact fires before first LLM main call', async () => {
    // 使用独立子目录避免互相干扰
    const manager = new SessionManager(workspaceDir + '/p2a');
    await manager.createSession('main');
    await prefillLargeHistory(manager, 4); // 足够触发 budget 超限

    // 调用顺序：generateSummary（无正常 LLM 首次调用）→ retry LLM 调用
    const llmClient = createSequentialMockLLM([
      summaryResponse('Preemptive summary.'),
      textResponse('Response after preemptive compaction.'),
    ]);

    const runner = new AgentRunner({ llmClient, sessionManager: manager });
    const result = await runner.run({
      sessionKey: 'main',
      message: 'Short question',
      model: 'test',
      systemPrompt: '',
      compaction: PREEMPTIVE_COMPACTION,
      contextWindowTokens: SMALL_CONTEXT_WINDOW,
    });

    assert.ok(result.compacted === true, `expected compacted=true, got ${result.compacted}`);
    assert.equal(result.text, 'Response after preemptive compaction.');

    const record = manager.getLastCompactionRecord('main');
    assert.ok(record !== null, 'expected CompactionRecord, got null');
    console.log(`  compacted=${result.compacted}, dropped=${record!.droppedMessages}`);
  });

  await runStep('Path 2b: compaction_start fires before first text_delta in preemptive path', async () => {
    const manager = new SessionManager(workspaceDir + '/p2b');
    await manager.createSession('main');
    await prefillLargeHistory(manager, 4);

    const llmClient = createSequentialMockLLM([
      summaryResponse('Summary.'),
      textResponse('Done.'),
    ]);

    const eventOrder: string[] = [];
    const runner = new AgentRunner({
      llmClient,
      sessionManager: manager,
      onEvent: (e) => {
        if (e.type === 'compaction_start' || e.type === 'text_delta') {
          eventOrder.push(e.type);
        }
      },
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Hi',
      model: 'test',
      systemPrompt: '',
      compaction: PREEMPTIVE_COMPACTION,
      contextWindowTokens: SMALL_CONTEXT_WINDOW,
    });

    const startIdx = eventOrder.indexOf('compaction_start');
    const firstTextIdx = eventOrder.indexOf('text_delta');
    assert.ok(startIdx >= 0, 'compaction_start not emitted');
    assert.ok(firstTextIdx < 0 || startIdx < firstTextIdx,
      `compaction_start(${startIdx}) should precede text_delta(${firstTextIdx})`);
    console.log(`  event order: [${eventOrder.join(', ')}]`);
  });

  // ── Path 3：MAX_COMPACTION_RETRIES 超限 ─────────────────────────

  await runStep('Path 3a: throws ContextOverflowError after MAX_COMPACTION_RETRIES', async () => {
    const manager = new SessionManager(workspaceDir + '/p3a');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    // 7 次调用全部抛错（3 次 retry × 2 次/retry + 1 次最终 retry = 7 次）
    const alwaysOverflow = Array.from({ length: 7 }, () => contextOverflowError());
    const llmClient = createSequentialMockLLM(alwaysOverflow);

    const runner = new AgentRunner({ llmClient, sessionManager: manager });

    let thrown: unknown;
    try {
      await runner.run({
        sessionKey: 'main',
        message: 'Test',
        model: 'test',
        systemPrompt: '',
        compaction: BASE_COMPACTION,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof ContextOverflowError,
      `expected ContextOverflowError, got: ${thrown instanceof Error ? thrown.constructor.name : String(thrown)}`);
    console.log(`  thrown: ${(thrown as Error).constructor.name}: "${(thrown as Error).message.slice(0, 80)}"`);
  });

  await runStep('Path 3b: exactly 3 CompactionRecords written before giving up', async () => {
    const manager = new SessionManager(workspaceDir + '/p3b');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    const alwaysOverflow = Array.from({ length: 7 }, () => contextOverflowError());
    const llmClient = createSequentialMockLLM(alwaysOverflow);

    const runner = new AgentRunner({ llmClient, sessionManager: manager });

    try {
      await runner.run({
        sessionKey: 'main',
        message: 'Test',
        model: 'test',
        systemPrompt: '',
        compaction: BASE_COMPACTION,
      });
    } catch {
      // expected
    }

    const count = manager.getSession('main')!.compactionCount ?? 0;
    assert.equal(count, 3, `expected compactionCount=3, got ${count}`);
    console.log(`  compactionCount=${count}`);
  });

  await runStep('Path 3c: exactly 3 compaction_start/end event pairs emitted', async () => {
    const manager = new SessionManager(workspaceDir + '/p3c');
    await manager.createSession('main');
    await prefillHistory(manager, 2);

    const alwaysOverflow = Array.from({ length: 7 }, () => contextOverflowError());
    const llmClient = createSequentialMockLLM(alwaysOverflow);

    let startCount = 0;
    let endCount = 0;
    const runner = new AgentRunner({
      llmClient,
      sessionManager: manager,
      onEvent: (e) => {
        if (e.type === 'compaction_start') startCount++;
        if (e.type === 'compaction_end') endCount++;
      },
    });

    try {
      await runner.run({
        sessionKey: 'main',
        message: 'Test',
        model: 'test',
        systemPrompt: '',
        compaction: BASE_COMPACTION,
      });
    } catch {
      // expected
    }

    assert.equal(startCount, 3, `expected 3 compaction_start events, got ${startCount}`);
    assert.equal(endCount, 3, `expected 3 compaction_end events, got ${endCount}`);
    console.log(`  compaction_start=${startCount}, compaction_end=${endCount}`);
  });

} finally {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

// ── 结果汇总 ─────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(72));

if (failed > 0) {
  process.exit(1);
}
