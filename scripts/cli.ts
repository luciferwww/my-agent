/**
 * Interactive CLI entry point built on the Channel layer.
 *
 * Replaces the legacy scripts/chat.ts. Uses RuntimeApp + CliChannel:
 *   - RuntimeApp.create() delegates composition to the authoritative Runtime
 *     Builder and returns a RuntimeHandle.
 *   - CliChannel reads stdin via readline and writes streaming output to stdout.
 *
 * Usage:
 *   npx tsx scripts/cli.ts
 *   npx tsx scripts/cli.ts --session=my-session
 *
 * Env vars (optional):
 *   ANTHROPIC_API_KEY   (default: 'EMPTY')
 *   ANTHROPIC_BASE_URL  (default: 'http://localhost:5000')
 *   MY_AGENT_MODEL      (default: 'gpt-4.1')
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import { createCliChannelModule } from '../src/runtime-modules/index.js';
import { createRuntimeHost } from './runtime-host.js';

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-workspace');

function parseSessionKey(): string {
  const arg = process.argv.find((a) => a.startsWith('--session='));
  return arg ? arg.slice('--session='.length) : 'main';
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
  const baseURL = /*process.env.ANTHROPIC_BASE_URL ??*/ 'http://localhost:5000';
  const model = process.env.MY_AGENT_MODEL ?? 'gpt-4.1';
  const sessionKey = parseSessionKey();

  console.log(bold('\n=== my-agent CLI ==='));
  console.log(`Workspace : ${WORKSPACE_DIR}`);
  console.log(`Base URL  : ${baseURL}`);
  console.log(`Model     : ${model}`);
  console.log(`Session   : ${sessionKey}`);
  console.log(dim('Ctrl+C: abort current turn / drop queue. Twice within 1s: quit.\nCtrl+D or EOF: quit gracefully.\n'));

  const app = await RuntimeApp.create({
    workspaceDir: WORKSPACE_DIR,
    loadedUnits: [createCliChannelModule({
      approval: true,
      sessionKey,
      prompt: '\n> ',
    })],
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: false },
    },
  });
  const host = createRuntimeHost(app);

  const completion = await app.application.waitForChannelCompletion('cli');

  await host.shutdown(completion.outcome === 'failed' ? 'cli channel failed' : 'cli exit');
  if (completion.outcome === 'failed') throw completion.error;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mFatal: ${message}\x1b[0m\n`);
  process.exitCode = 1;
});
