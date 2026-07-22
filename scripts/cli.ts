/**
 * Interactive CLI entry point built on the Channel layer.
 *
 * Replaces the legacy scripts/chat.ts. Uses RuntimeApp + CliChannel:
 *   - RuntimeApp.create() boots the runtime with a fanout closure that delivers
 *     AgentEvents to all registered channels.
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
import { CliChannel } from '../src/adapters/channel/index.js';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';

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
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: false },
    },
  });

  const cli = new CliChannel({
    approval: true,
    sessionKey,
    prompt: '\n> ',
  });

  app.registerChannel(cli);

  // NOTE: 不再自己 register SIGINT handler——CliChannel.start() 会
  // `process.removeAllListeners('SIGINT')` 后转交给自己的双击-退出 UX（
  // core-abort-spec.md §12）。下面 startChannels 发回后（readline 自然 close
  // 或 CliChannel 内部 exit）才走 app.close() 做优雅 shutdown。
  await app.startChannels();

  // 正常回新到这里意味着 readline close（Ctrl+D / EOF）。走一遍 graceful
  // close；双-Ctrl+C 路径已在 handleSigInt 里 process.exit(130)，不到这里。
  await app.close('cli exit');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mFatal: ${message}\x1b[0m\n`);
  process.exit(1);
});
