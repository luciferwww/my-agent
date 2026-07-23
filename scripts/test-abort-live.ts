/**
 * Live abort demo against a real LLM proxy.
 *
 * Complements scripts/test-abort-e2e.ts (which uses a mock LLM). Talks
 * to a real model, sends a prompt that produces a long streaming
 * response, then simulates a user Ctrl+C ~1s in by calling
 * `app.abortTurn(sk)`. Asserts the turn ends quickly with
 * `stopReason='aborted'` and streamed some but not all of the reply.
 *
 * Not part of CI. Cost is ~one LLM call worth of input + a handful of
 * output tokens (abort cuts the stream early).
 *
 * Usage:
 *   npx tsx scripts/test-abort-live.ts
 *
 * Env vars (optional):
 *   ANTHROPIC_API_KEY   default 'EMPTY' (permissive local proxies)
 *   ANTHROPIC_BASE_URL  default 'http://localhost:5000'
 *   MY_AGENT_MODEL      default 'claude-haiku-4.5'
 *   ABORT_AFTER_MS      default 1000 (window before firing abort)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type { AgentEvent } from '../src/core/runner/index.js';

const API_KEY = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://localhost:5000';
const MODEL = process.env.MY_AGENT_MODEL ?? 'claude-haiku-4.5';
const ABORT_AFTER_MS = Number(process.env.ABORT_AFTER_MS ?? 1000);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'abort-live-'));
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
            runner: { inTurnMessageMode: 'followup', maxLlmCalls: 3 },
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
    '# Identity\nYou are a verbose demo assistant. Follow instructions literally.',
    'utf-8',
  );
}

async function main(): Promise<void> {
  console.log(bold('\n=== abort-live demo ==='));
  console.log(`Base URL     : ${BASE_URL}`);
  console.log(`Model        : ${MODEL}`);
  console.log(`Abort after  : ${ABORT_AFTER_MS}ms`);
  console.log('');

  await withWorkspace(async (workspaceDir) => {
    await setupWorkspace(workspaceDir);

    let deltaCount = 0;
    let firstDeltaAt = 0;
    const events: AgentEvent[] = [];
    const onAgentEvent = (e: AgentEvent) => {
      events.push(e);
      if (e.type === 'text_delta') {
        if (deltaCount === 0) firstDeltaAt = Date.now();
        deltaCount += 1;
        // Live progress dot to make abort UX visible.
        process.stdout.write('.');
      }
      if (e.type === 'error') {
        console.error(red(`\n  [agent error] ${e.error.message}`));
      }
    };

    const app = await RuntimeApp.create({ workspaceDir, onAgentEvent });
    const sk = 'main';

    // Fire abort ABORT_AFTER_MS after runTurn returns (not from start of
    // the setTimeout — we want an accurate "user pressed Ctrl+C 1s in"
    // measurement, not "1s of setup + LLM call"). timer starts inside the
    // runTurn call site below.
    const t0 = Date.now();

    // Prompt is deliberately long-response so we have a comfortable
    // window: enumerate items with detail. If the model responds too
    // quickly, bump ABORT_AFTER_MS down or make the prompt longer.
    const prompt =
      "List 30 English words that start with the letter A. Give each " +
      "word with a one-sentence definition on its own line, numbered. " +
      "Take your time and be thorough. Do NOT summarize or truncate.";

    const abortTimer = setTimeout(() => {
      const r = app.abortTurn(sk);
      console.log(
        `\n${red('[⚠ abort fired]')} after ${Date.now() - t0}ms — ${JSON.stringify(r)}`,
      );
    }, ABORT_AFTER_MS);

    try {
      const result = await app.runTurn({
        sessionKey: sk,
        message: prompt,
        promptMode: 'full',
      });
      const wallMs = Date.now() - t0;
      const streamWindowMs = firstDeltaAt > 0 ? Date.now() - firstDeltaAt : 0;

      console.log(''); // finish the dot line
      console.log(`\n${bold('result.stopReason  ')} ${result.stopReason}`);
      console.log(`${bold('result.text length ')} ${result.text.length} chars`);
      console.log(`${bold('result.usage       ')} ${JSON.stringify(result.usage)}`);
      console.log(`${bold('text deltas seen   ')} ${deltaCount}`);
      console.log(`${bold('wall time          ')} ${wallMs}ms  (stream window ~${streamWindowMs}ms)`);
      console.log(`${bold('text preview       ')} ${dim(JSON.stringify(result.text.slice(0, 160)))}...`);

      // ── Assertions ─────────────────────────────────────
      // MUST-hold invariants (regardless of streaming timing):
      //   1. stopReason === 'aborted'
      //   2. turn returns within the abort budget (fast unwind)
      //   3. session has partial assistant record with abortMeta
      // Streaming-window details (deltaCount / text length) are
      // informational — they depend on model time-to-first-token vs
      // ABORT_AFTER_MS. Bump ABORT_AFTER_MS to see partial text.
      let ok = true;
      const check = (cond: boolean, name: string, extra = ''): void => {
        console.log(`  ${cond ? green('PASS') : red('FAIL')}  ${name}${extra ? ' — ' + extra : ''}`);
        if (!cond) ok = false;
      };
      const info = (name: string, extra = ''): void => {
        console.log(`  ${dim('info')}  ${name}${extra ? ' — ' + extra : ''}`);
      };

      check(result.stopReason === 'aborted', "stopReason === 'aborted'",
        `got ${result.stopReason}`);
      // Abort responsiveness: from abort fire to turn end, unwind should
      // complete quickly. Loose upper bound because network / proxy jitter.
      check(wallMs < ABORT_AFTER_MS + 3000,
        `wall time within ABORT_AFTER_MS + 3s budget`,
        `wallMs=${wallMs}, budget=${ABORT_AFTER_MS + 3000}`);
      // Assistant record on disk must carry abortMeta (§6.5).
      const records = (app as unknown as {
        resources: { sessionManager: { getMessages(k: string): Array<{
          message: { role: string; abortMeta?: { partial: boolean; stopReason: 'aborted' } };
        }> } };
      }).resources.sessionManager.getMessages(sk);
      const lastAssistant = [...records].reverse().find((r) => r.message.role === 'assistant');
      check(!!lastAssistant, 'partial assistant record written');
      check(
        lastAssistant?.message.abortMeta?.partial === true &&
          lastAssistant?.message.abortMeta?.stopReason === 'aborted',
        'assistant.abortMeta = { partial: true, stopReason: "aborted" }',
      );

      // Informational: streaming activity before abort. May be zero if
      // the model is slow to first-token relative to ABORT_AFTER_MS.
      info(`text deltas before abort: ${deltaCount}`);
      info(`partial text length: ${result.text.length} chars`);
      if (deltaCount === 0) {
        console.log(dim(
          '  (No deltas seen — model was likely still processing input when abort fired. ' +
          'Bump ABORT_AFTER_MS to give the stream time to open.)',
        ));
      }

      console.log('');
      if (!ok) {
        console.error(red('One or more assertions failed.'));
        process.exit(1);
      }
      console.log(green('All assertions passed.'));
    } catch (err) {
      console.error(red(`\nturn threw (should not happen — abort surfaces as result): ${
        err instanceof Error ? err.message : String(err)
      }`));
      process.exit(1);
    } finally {
      clearTimeout(abortTimer);
      await app.close('abort-live done').catch(() => undefined);
    }
  });
}

main().catch((err) => {
  console.error('unhandled error:', err);
  process.exit(1);
});
