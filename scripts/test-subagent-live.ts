/**
 * Live subagent demo against a real LLM proxy (Claude via http://localhost:5000).
 *
 * Unlike scripts/test-subagent-e2e.ts (which uses a mock LLM), this script
 * talks to a real model through the real Parent task path: send a user message
 * asking the parent to delegate to
 *      the `task` tool; the parent's LLM picks `general-purpose`, the
 *      subagent answers, the parent wraps the response.
 *
 * Usage:
 *   npx tsx scripts/test-subagent-live.ts
 *
 * Env vars (optional):
 *   ANTHROPIC_API_KEY   default 'EMPTY' (works with permissive local proxies)
 *   ANTHROPIC_BASE_URL  default 'http://localhost:5000'
 *   MY_AGENT_MODEL      default 'claude-haiku-4.5' (cheapest)
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type { AgentEvent } from '../src/core/runner/index.js';

const API_KEY = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://localhost:5000';
const MODEL = process.env.MY_AGENT_MODEL ?? 'claude-haiku-4.5';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'subagent-live-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setupWorkspace(dir: string): Promise<void> {
  const agentDir = join(dir, '.agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'config.json'),
    JSON.stringify(
      {
        agents: {
          defaults: {
            llm: { apiKey: API_KEY, baseURL: BASE_URL, model: MODEL },
            memory: { enabled: false },
            // Reduce log noise. The CLI integration uses 'steer' but for a one-shot
            // script we want plain sequential behavior.
            runner: { inTurnMessageMode: 'followup', maxLlmCalls: 6 },
          },
        },
        logger: {
          minLevel: 'warn',
          console: { enabled: true, minLevel: 'warn' },
          file: { enabled: false },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(
    join(agentDir, 'IDENTITY.md'),
    '# Identity\nYou are a concise demo assistant. Keep answers short.',
    'utf-8',
  );
}

function trackerFor(): { onEvent: (e: AgentEvent) => void; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    onEvent: (e) => {
      events.push(e);
      switch (e.type) {
        case 'subagent_start':
          console.log(
            cyan(`  [▶ subagent start] type=${e.subagentType} depth=${e.depth} runId=${e.runId.slice(0, 8)}`),
          );
          break;
        case 'subagent_end':
          console.log(
            cyan(
              `  [◀ subagent end]   outcome=${e.outcome} usage=${JSON.stringify(e.usage)} duration=${e.durationMs}ms${e.failure ? ` failure="${e.failure.message}"` : ''}`,
            ),
          );
          break;
        case 'tool_use':
          console.log(dim(`  [tool_use] name=${e.name} input=${JSON.stringify(e.input).slice(0, 120)}`));
          break;
        case 'tool_result':
          console.log(
            dim(
              `  [tool_result] name=${e.name} isError=${!!e.result.isError} preview=${JSON.stringify(e.result.content).slice(0, 100)}`,
            ),
          );
          break;
        case 'error':
          console.error(dim(`  [agent error] ${e.error.message}`));
          break;
      }
    },
  };
}

// ── Real Parent task path ──────────────────────────────────

async function scenarioTaskTool(): Promise<void> {
  console.log(`\n${'-'.repeat(72)}`);
  console.log(bold('Parent task path — parent → task → subagent → final answer'));
  console.log('-'.repeat(72));

  await withWorkspace(async (workspaceDir) => {
    await setupWorkspace(workspaceDir);
    const { onEvent, events } = trackerFor();
    const app = await RuntimeApp.create({ workspaceDir, onAgentEvent: onEvent });

    try {
      const t0 = Date.now();
      const result = await app.application.runTurn({
        sessionKey: 'main',
        // Heavy hint so even small models reach for the task tool.
        message:
          "Use the `task` tool to delegate to a general-purpose subagent. " +
          "Set subagent_type='general-purpose', description='count to three', " +
          "and prompt='Reply with exactly: ONE TWO THREE'. " +
          "Then return the subagent's answer to me as your final response.",
        promptMode: 'full',
      });
      const wallMs = Date.now() - t0;

      console.log(`\n  ${bold('result.text      ')} ${JSON.stringify(result.text)}`);
      console.log(`  ${bold('result.toolRounds')} ${result.toolRounds}`);
      console.log(`  ${bold('result.usage     ')} ${JSON.stringify(result.usage)}`);
      console.log(`  ${bold('result.stopReason')} ${result.stopReason}`);
      console.log(`  ${bold('wall time        ')} ${wallMs}ms`);
      console.log(`  ${bold('event sequence   ')}`);
      for (const e of events) {
        console.log(`    - ${e.type}`);
      }

      const sawSubagent = events.some(
        (e) => e.type === 'subagent_start' || e.type === 'subagent_end',
      );
      if (!sawSubagent) {
        console.log(
          dim(
            `\n  NOTE: the model chose not to call \`task\`. Try a bigger model: ` +
              `MY_AGENT_MODEL=claude-sonnet-4.6 npx tsx scripts/test-subagent-live.ts`,
          ),
        );
      }
    } finally {
      await app.close('demo done').catch(() => undefined);
    }
  });
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(bold('\n=== my-agent subagent live demo ==='));
  console.log(`  api_key   = ${API_KEY === 'EMPTY' ? '(EMPTY, relying on proxy)' : '****'}`);
  console.log(`  base_url  = ${BASE_URL}`);
  console.log(`  model     = ${MODEL}`);

  try {
    await scenarioTaskTool();
  } catch (err) {
    console.error('\nunhandled error:', err);
    process.exit(1);
  }
}

main();
