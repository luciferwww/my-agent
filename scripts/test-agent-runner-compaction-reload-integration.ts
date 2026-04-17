/**
 * AgentRunner 压缩记录重载集成测试（P1）。
 *
 * 验证 loadHistory() 在存在 CompactionRecord 时的正确行为：
 *   1. 摘要消息注入为历史第一条
 *   2. firstKeptEntryId 之前的旧消息被截断（不传给 LLM）
 *   3. 压缩记录跨 SessionManager 实例重启后仍然有效
 *   4. 多条压缩记录时以最新的为准
 *   5. 无压缩记录时全量历史原样传入
 *
 * 与 test-agent-runner-compaction-integration.ts 的区别：
 *   - 该脚本（P0）验证压缩流程本身（overflow → compact → retry）
 *   - 本脚本（P1）验证压缩结果的持久化与重载（CompactionRecord → loadHistory → LLM input）
 *   - 通过直接调用 appendCompactionRecord() 写入记录，绕开 LLM 摘要生成，
 *     精确控制 firstKeptEntryId 和 summary，使断言更确定
 *
 * Usage:
 *   npx tsx scripts/test-agent-runner-compaction-reload-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { AgentRunner } from '../src/agent-runner/index.js';
import { SessionManager } from '../src/session/index.js';
import type { StreamEvent, ChatParams } from '../src/llm-client/types.js';

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

// ── Mock LLM 工厂 ─────────────────────────────────────────────────

/**
 * 追踪型 mock LLM：每次调用时将 params.messages 写入 captured，
 * 并返回固定文本回复。用于断言 LLM 实际收到了哪些历史消息。
 */
function createTrackingLLM(captured: { messages: ChatParams['messages'] }) {
  return {
    async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
      // 记录本次调用传入的 messages（仅最后一次调用的快照，对单轮对话足够）
      captured.messages = params.messages.map((m) => ({ ...m }));
      yield { type: 'text_delta', text: 'Response.' };
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } };
    },
    async chat(): Promise<never> {
      throw new Error('Not used');
    },
  };
}

// ── 测试辅助 ─────────────────────────────────────────────────────

/**
 * 构造一条最小 CompactionRecord（不含 parentId / firstKeptEntryId，
 * 这两个字段由 appendCompactionRecord 内部填入）。
 */
function makeCompactionInput(summary: string, timestamp?: string) {
  return {
    type: 'compaction' as const,
    id: randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
    summary,
    tokensBefore: 500,
    tokensAfter: 100,
    trigger: 'overflow' as const,
    droppedMessages: 4,
  };
}

/** 向 session 追加 N 轮 user/assistant 消息，返回各条消息的 ID */
async function appendTurns(
  manager: SessionManager,
  turns: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= turns; i++) {
    ids.push(
      await manager.appendMessage('main', {
        role: 'user',
        content: `Turn ${i} user message.`,
      }),
    );
    ids.push(
      await manager.appendMessage('main', {
        role: 'assistant',
        content: [{ type: 'text', text: `Turn ${i} assistant reply.` }],
      }),
    );
  }
  return ids;
}

// ── 入口 ─────────────────────────────────────────────────────────

console.log('\n=== AgentRunner Compaction Reload Integration Test (P1) ===\n');

let workspaceDir = '';

try {
  workspaceDir = await mkdtemp(join(tmpdir(), 'compaction-reload-integration-'));

  // ── Step 1：摘要消息注入为历史第一条 ──────────────────────────

  await runStep('Step 1: summary message injected as first message in LLM input', async () => {
    const manager = new SessionManager(workspaceDir + '/s1');
    await manager.createSession('main');

    // 预填 2 轮历史：turn1/reply1（将被截断）+ turn2/reply2（将被保留）
    const ids = await appendTurns(manager, 2);
    const turn2Id = ids[2]!; // turn2 的消息 ID（第 3 条，索引 2）

    // 手动写入压缩记录：firstKeptEntryId = turn2 的 ID
    await manager.appendCompactionRecord(
      'main',
      makeCompactionInput('The user asked about turn 1 and 2. Agent replied.'),
      turn2Id,
    );

    // 运行 agent，追踪 LLM 收到的 messages
    const captured: { messages: ChatParams['messages'] } = { messages: [] };
    const runner = new AgentRunner({
      llmClient: createTrackingLLM(captured),
      sessionManager: manager,
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Current question',
      model: 'test',
      systemPrompt: '',
    });

    // 第一条消息应包含 [Previous conversation summary] 标记
    const firstMsg = captured.messages[0];
    assert.ok(firstMsg, 'LLM received no messages');
    assert.ok(
      typeof firstMsg.content === 'string' && firstMsg.content.includes('[Previous conversation summary]'),
      `expected summary injection as first message, got: "${String(firstMsg.content).slice(0, 100)}"`,
    );
    assert.ok(
      typeof firstMsg.content === 'string' && firstMsg.content.includes('The user asked about turn 1 and 2'),
      `summary text not found in first message`,
    );
    console.log(`  first message role="${firstMsg.role}", starts with: "${String(firstMsg.content).slice(0, 60)}..."`);
  });

  // ── Step 2：firstKeptEntryId 之前的旧消息不传给 LLM ────────────

  await runStep('Step 2: messages before firstKeptEntryId are excluded from LLM input', async () => {
    const manager = new SessionManager(workspaceDir + '/s2');
    await manager.createSession('main');

    const ids = await appendTurns(manager, 2);
    const turn2Id = ids[2]!; // turn2 是保留区起点

    await manager.appendCompactionRecord('main', makeCompactionInput('Summary.'), turn2Id);

    const captured: { messages: ChatParams['messages'] } = { messages: [] };
    const runner = new AgentRunner({
      llmClient: createTrackingLLM(captured),
      sessionManager: manager,
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Current question',
      model: 'test',
      systemPrompt: '',
    });

    // turn1 的内容（压缩区）不应出现在 LLM 收到的任何消息中
    const allContent = captured.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    assert.ok(
      !allContent.includes('Turn 1 user message.'),
      `LLM should not receive turn 1 user message, but it was found in: "${allContent.slice(0, 200)}"`,
    );
    assert.ok(
      !allContent.includes('Turn 1 assistant reply.'),
      `LLM should not receive turn 1 assistant reply`,
    );

    // turn2 的内容（保留区）应出现在 LLM 收到的消息中
    assert.ok(
      allContent.includes('Turn 2 user message.'),
      `LLM should receive turn 2 user message`,
    );

    console.log(`  LLM message count=${captured.messages.length}`);
    console.log(`  turn1 excluded=true, turn2 included=true`);
  });

  // ── Step 3：压缩记录跨 SessionManager 重启后仍有效 ─────────────

  await runStep('Step 3: compaction record survives SessionManager restart', async () => {
    const subDir = workspaceDir + '/s3';

    // ── 实例 A：写入消息 + 压缩记录 ──
    const managerA = new SessionManager(subDir);
    await managerA.createSession('main');

    const ids = await appendTurns(managerA, 2);
    const turn2Id = ids[2]!;

    await managerA.appendCompactionRecord(
      'main',
      makeCompactionInput('Summary written before restart.'),
      turn2Id,
    );

    console.log(`  [restart simulation] creating new SessionManager from same directory`);

    // ── 实例 B：模拟重启，从磁盘重新加载 ──
    const managerB = new SessionManager(subDir);

    const captured: { messages: ChatParams['messages'] } = { messages: [] };
    const runner = new AgentRunner({
      llmClient: createTrackingLLM(captured),
      sessionManager: managerB,
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Post-restart question',
      model: 'test',
      systemPrompt: '',
    });

    // 重启后仍应看到摘要注入
    const firstMsg = captured.messages[0];
    assert.ok(
      typeof firstMsg?.content === 'string' && firstMsg.content.includes('[Previous conversation summary]'),
      `summary injection should survive restart, first msg: "${String(firstMsg?.content).slice(0, 100)}"`,
    );
    assert.ok(
      typeof firstMsg?.content === 'string' && firstMsg.content.includes('Summary written before restart.'),
      `summary text should survive restart`,
    );

    // turn1 仍应被截断
    const allContent = captured.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    assert.ok(!allContent.includes('Turn 1 user message.'), 'turn 1 should still be excluded after restart');

    console.log(`  summary injection after restart: OK`);
    console.log(`  turn1 still excluded after restart: OK`);
  });

  // ── Step 4：多条压缩记录时以时间戳最新的为准 ───────────────────

  await runStep('Step 4: most recent compaction record is used when multiple exist', async () => {
    const manager = new SessionManager(workspaceDir + '/s4');
    await manager.createSession('main');

    // 预填 3 轮历史
    const ids = await appendTurns(manager, 3);
    const turn1Id = ids[0]!; // 第 1 条消息
    const turn2Id = ids[2]!; // 第 3 条消息（turn2 起点）
    const turn3Id = ids[4]!; // 第 5 条消息（turn3 起点）

    // 压缩记录 A（较早）：firstKeptEntryId = turn2（保留 turn2 + turn3）
    await manager.appendCompactionRecord(
      'main',
      makeCompactionInput('Older summary: kept turn2 onward.', '2026-04-01T08:00:00Z'),
      turn2Id,
    );

    // 压缩记录 B（较晚）：firstKeptEntryId = turn3（只保留 turn3）
    await manager.appendCompactionRecord(
      'main',
      makeCompactionInput('Newer summary: kept turn3 only.', '2026-04-01T12:00:00Z'),
      turn3Id,
    );

    const captured: { messages: ChatParams['messages'] } = { messages: [] };
    const runner = new AgentRunner({
      llmClient: createTrackingLLM(captured),
      sessionManager: manager,
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Current',
      model: 'test',
      systemPrompt: '',
    });

    // 应使用记录 B（较晚）的 summary 和 firstKeptEntryId
    const firstMsg = captured.messages[0];
    assert.ok(
      typeof firstMsg?.content === 'string' && firstMsg.content.includes('Newer summary: kept turn3 only.'),
      `expected newer summary, got: "${String(firstMsg?.content).slice(0, 100)}"`,
    );

    const allContent = captured.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    // turn1 和 turn2 均应被截断（只保留 turn3）
    assert.ok(!allContent.includes('Turn 1 user message.'), 'turn 1 should be excluded');
    assert.ok(!allContent.includes('Turn 2 user message.'), 'turn 2 should be excluded (newer record keeps turn3 only)');
    assert.ok(allContent.includes('Turn 3 user message.'), 'turn 3 should be included');

    console.log(`  newer summary used: OK`);
    console.log(`  turn1 excluded, turn2 excluded, turn3 included: OK`);
  });

  // ── Step 5：无压缩记录时全量历史原样传入 ───────────────────────

  await runStep('Step 5: full history passed to LLM when no compaction record exists', async () => {
    const manager = new SessionManager(workspaceDir + '/s5');
    await manager.createSession('main');

    // 预填 2 轮历史，不写压缩记录
    await appendTurns(manager, 2);

    const captured: { messages: ChatParams['messages'] } = { messages: [] };
    const runner = new AgentRunner({
      llmClient: createTrackingLLM(captured),
      sessionManager: manager,
    });

    await runner.run({
      sessionKey: 'main',
      message: 'Current',
      model: 'test',
      systemPrompt: '',
    });

    const allContent = captured.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');

    // 所有历史消息均应存在
    assert.ok(allContent.includes('Turn 1 user message.'), 'turn 1 should be present');
    assert.ok(allContent.includes('Turn 2 user message.'), 'turn 2 should be present');

    // 不应有摘要注入
    assert.ok(
      !allContent.includes('[Previous conversation summary]'),
      'no summary injection expected when no compaction record exists',
    );

    console.log(`  all history present, no summary injection: OK`);
    console.log(`  total messages passed to LLM: ${captured.messages.length}`);
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
