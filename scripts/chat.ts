/**
 * Interactive CLI chat interface for my-agent.
 *
 * Streams LLM output character-by-character via AgentRunner.onEvent injection.
 * Tool calls and compaction events are displayed inline.
 *
 * Usage:
 *   npx tsx scripts/chat.ts
 *   npx tsx scripts/chat.ts --session=my-session
 *
 * Commands:
 *   /exit   — quit
 *   /clear  — start a new session (new session key)
 *
 * Env vars (optional):
 *   ANTHROPIC_API_KEY   (default: 'EMPTY')
 *   ANTHROPIC_BASE_URL  (default: 'http://localhost:5000')
 *   MY_AGENT_MODEL      (default: 'gpt-4.1')
 */

import * as readline from 'readline';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentRunner } from '../src/agent-runner/index.js';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type { AgentEvent } from '../src/agent-runner/types.js';

// ── Constants ─────────────────────────────────────────────────────

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-workspace');
const MAX_TOOL_RESULT_PREVIEW = 200;

// ── ANSI helpers ──────────────────────────────────────────────────

const dim    = (s: string) => `\x1b[90m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;

// ── Session key from args ─────────────────────────────────────────

function parseSessionKey(): string {
  const arg = process.argv.find((a) => a.startsWith('--session='));
  return arg ? arg.slice('--session='.length) : 'main';
}

// ── AgentEvent handler (injected into AgentRunner) ────────────────

function makeAgentEventHandler(): (event: AgentEvent) => void {
  let inStream = false;

  return (event) => {
    switch (event.type) {
      case 'text_delta':
        if (!inStream) inStream = true;
        process.stdout.write(event.text);
        break;

      case 'tool_use':
        if (inStream) { process.stdout.write('\n'); inStream = false; }
        process.stdout.write(dim(`[tool: ${event.name}]\n`));
        break;

      case 'tool_result': {
        const preview = event.result.content.length > MAX_TOOL_RESULT_PREVIEW
          ? event.result.content.slice(0, MAX_TOOL_RESULT_PREVIEW) + '…'
          : event.result.content;
        const label = event.result.isError ? red('[tool error]') : dim('[tool result]');
        process.stdout.write(`${label} ${dim(preview)}\n`);
        break;
      }

      case 'compaction_start':
        if (inStream) { process.stdout.write('\n'); inStream = false; }
        process.stdout.write(yellow(`[compacting… trigger=${event.trigger}]\n`));
        break;

      case 'compaction_end':
        process.stdout.write(yellow(`[compacted: ${event.tokensBefore} → ${event.tokensAfter} tokens, dropped ${event.droppedMessages} messages]\n`));
        break;

      case 'run_end':
        if (inStream) { process.stdout.write('\n'); inStream = false; }
        break;
    }
  };
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey  = /*process.env.ANTHROPIC_API_KEY  ??*/ 'EMPTY';
  const baseURL = /*process.env.ANTHROPIC_BASE_URL ??*/ 'http://localhost:5000';
  const model   = /*process.env.MY_AGENT_MODEL     ??*/ 'gpt-4.1';

  let sessionKey = parseSessionKey();

  console.log(bold('\n=== my-agent CLI ==='));
  console.log(`Workspace : ${WORKSPACE_DIR}`);
  console.log(`Model     : ${model}`);
  console.log(`Session   : ${sessionKey}`);
  console.log(dim('Type /exit to quit, /clear to start a new session.\n'));

  const onAgentEvent = makeAgentEventHandler();

  const app = await RuntimeApp.create({
    workspaceDir: WORKSPACE_DIR,
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: false },
    },
    dependencies: {
      createAgentRunner(config) {
        return new AgentRunner({ ...config, onEvent: onAgentEvent });
      },
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Graceful shutdown on Ctrl+C or rl close
  const shutdown = async () => {
    process.stdout.write('\n');
    rl.close();
    await app.close('user exit');
    process.exit(0);
  };

  rl.on('close', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // ── Input loop ────────────────────────────────────────────────

  const prompt = (): Promise<string> =>
    new Promise((resolve) => rl.question('\n> ', resolve));

  while (true) {
    const input = (await prompt()).trim();

    if (!input) continue;

    if (input === '/exit') {
      await shutdown();
      break;
    }

    if (input === '/clear') {
      sessionKey = `session-${Date.now()}`;
      console.log(dim(`[new session: ${sessionKey}]`));
      continue;
    }

    try {
      await app.runTurn({
        sessionKey,
        message: input,
        model,
        maxTokens: 4096,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(red(`\n[error] ${message}\n`));
    }
  }
}

main().catch((err) => {
  console.error(red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
