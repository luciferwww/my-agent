/**
 * End-to-end subagent demo (manual test, not part of vitest).
 *
 * Exercises the v1 subagent stack from PR-(-1) through PR-6 against a
 * mock LLM client so it runs offline with no API key required.
 *
 * Scenario
 *   LLM tool path: main agent emits a `task` tool_use, subagent runs,
 *      main agent gets the tool_result and produces a final answer.
 *
 * Usage:
 *   npx tsx scripts/test-subagent-e2e.ts
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type {
  ChatParams,
  ChatResponse,
  LLMClient,
  StreamEvent,
} from '../src/adapters/llm/types.js';
import type { AgentEvent } from '../src/core/runner/index.js';

// ── runStep harness ─────────────────────────────────────────

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

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Scripted mock LLM ───────────────────────────────────────

/**
 * A mock LLM that returns scripted responses, picked by inspecting the
 * incoming `params` so the same client can serve both the parent and
 * subagent turns. The selector reads the first user message text and
 * matches a predicate.
 */
interface ScriptedReply {
  match: (params: ChatParams) => boolean;
  events: StreamEvent[];
}

function createScriptedLLM(replies: ScriptedReply[]): { client: LLMClient; calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  const client: LLMClient = {
    async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
      calls.push(params);
      const hit = replies.find((r) => r.match(params));
      if (!hit) {
        throw new Error(
          `mock LLM: no scripted reply matched. system="${(params.system ?? '').slice(0, 80)}..." ` +
            `messages=${JSON.stringify(params.messages).slice(0, 200)}`,
        );
      }
      for (const ev of hit.events) yield ev;
    },
    async chat(): Promise<ChatResponse> {
      throw new Error('non-stream chat not used');
    },
  };
  return { client, calls };
}

function textReply(text: string, usage = { inputTokens: 10, outputTokens: 5 }): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage },
  ];
}

function toolUseReply(opts: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
}): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'tool_use', id: opts.id, name: opts.name, input: opts.input },
    {
      type: 'message_end',
      stopReason: 'tool_use',
      usage: opts.usage ?? { inputTokens: 20, outputTokens: 10 },
    },
  ];
}

// ── Helpers to write config + identity ────────────────────

async function writeAgentDir(workspaceDir: string, configJson: object): Promise<void> {
  const agentDir = join(workspaceDir, '.agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'config.json'), JSON.stringify(configJson, null, 2), 'utf-8');
  await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity\nDemo agent.', 'utf-8');
}

// ── Real Parent task path ──────────────────────────────────

async function scenarioTaskToolPath(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    await writeAgentDir(workspaceDir, {
      agents: { defaults: { llm: { apiKey: 'x', model: 'mock-model' }, memory: { enabled: false } } },
    });

    // Match logic: distinguish parent vs subagent by system prompt content.
    // Parent has '# Behavior Rules' (full mode), subagent does not (minimal).
    const isSubagent = (p: ChatParams) =>
      !!p.system && !p.system.includes('# Behavior Rules');
    const lastIsToolResult = (p: ChatParams) => {
      const last = p.messages[p.messages.length - 1];
      if (!last || last.role !== 'user' || !Array.isArray(last.content)) return false;
      return last.content.some((b) => (b as { type: string }).type === 'tool_result');
    };

    const { client } = createScriptedLLM([
      // 1st parent call: emit a `task` tool_use.
      {
        match: (p) => !isSubagent(p) && !lastIsToolResult(p),
        events: toolUseReply({
          id: 'tu_parent_1',
          name: 'task',
          input: {
            subagent_type: 'general-purpose',
            description: 'demo subtask',
            prompt: 'reply with exactly: SUBAGENT-OUTPUT',
          },
        }),
      },
      // Subagent turn: plain text.
      {
        match: (p) => isSubagent(p),
        events: textReply('SUBAGENT-OUTPUT', { inputTokens: 30, outputTokens: 5 }),
      },
      // 2nd parent call: receive tool_result, emit final answer.
      {
        match: (p) => !isSubagent(p) && lastIsToolResult(p),
        events: textReply('Subagent said: SUBAGENT-OUTPUT', { inputTokens: 60, outputTokens: 12 }),
      },
    ]);

    const events: AgentEvent[] = [];

    const app = await RuntimeApp.create({
      workspaceDir,
      onAgentEvent: (e) => events.push(e),
      dependencies: { createLLMClient: () => client },
    });

    try {
      const result = await app.application.runTurn({
        sessionKey: 'main',
        message: 'please use the task tool to fetch SUBAGENT-OUTPUT',
        promptMode: 'full',
      });

      const seq = events.map((e) => e.type).join(' → ');
      console.log('  result.text       =', JSON.stringify(result.text));
      console.log('  result.toolRounds =', result.toolRounds);
      console.log('  result.usage      =', result.usage);
      console.log('  event sequence    =', seq);

      assert.equal(
        result.text,
        'Subagent said: SUBAGENT-OUTPUT',
        'parent should finish with the wrapped subagent text',
      );
      assert.equal(result.toolRounds, 1, 'one tool round (the task call)');
      assert.ok(
        events.some((e) => e.type === 'subagent_start'),
        'subagent_start should fire',
      );
      assert.ok(
        events.some((e) => e.type === 'subagent_end'),
        'subagent_end should fire',
      );

      // Parent usage = self + child (spec §13.2). With our scripted numbers:
      //   parent self: round1 (20,10) + round2 (60,12) = (80, 22)
      // Child usage is tracked separately via subagent_end.usage; AgentRunner
      // accumulates only its own calls so this assertion documents the
      // parent-only accumulation invariant.
      assert.equal(result.usage.inputTokens, 80, 'parent self inputTokens accumulation');
      assert.equal(result.usage.outputTokens, 22, 'parent self outputTokens accumulation');

      const end = events.find((e) => e.type === 'subagent_end') as
        | Extract<AgentEvent, { type: 'subagent_end' }>
        | undefined;
      assert.ok(end, 'subagent_end exists');
      assert.equal(end!.usage.inputTokens, 30, 'child usage from subagent_end');
      assert.equal(end!.outcome, 'ok');
    } finally {
      await app.close('demo done').catch(() => undefined);
    }
  });
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runStep('real Parent task path: parent → task → subagent → final answer', scenarioTaskToolPath);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('unhandled error:', err);
  process.exit(1);
});
