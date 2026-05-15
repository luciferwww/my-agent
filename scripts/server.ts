/**
 * WebSocket server entry point built on the Channel layer.
 *
 * Boots a RuntimeApp and exposes it via WebSocketChannel with approval enabled,
 * meant to be paired with the web client at clients/web/index.html.
 *
 * Usage:
 *   npx tsx scripts/server.ts
 *   npx tsx scripts/server.ts --port=9000
 *
 * Env vars (optional):
 *   ANTHROPIC_API_KEY   (default: 'EMPTY')
 *   MY_AGENT_MODEL      (default: 'gpt-4.1')
 *   MY_AGENT_WS_PORT    (default: 8787)
 *   MY_AGENT_WS_HOST    (default: '127.0.0.1')
 *
 * Note: like scripts/cli.ts, the LLM baseURL is hard-coded to the local proxy
 * (http://localhost:5000). Change this file if you need a different endpoint.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketChannel } from '../src/adapters/channel/index.js';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-workspace');

function parseIntArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const parsed = Number.parseInt(arg.slice(`--${name}=`.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
  const baseURL = /*process.env.ANTHROPIC_BASE_URL ??*/ 'http://localhost:5000';
  const model = process.env.MY_AGENT_MODEL ?? 'gpt-4.1';
  const port = parseIntArg('port', Number.parseInt(process.env.MY_AGENT_WS_PORT ?? '8787', 10) || 8787);
  const host = process.env.MY_AGENT_WS_HOST ?? '127.0.0.1';

  console.log(bold('\n=== my-agent WebSocket server ==='));
  console.log(`Workspace : ${WORKSPACE_DIR}`);
  console.log(`Base URL  : ${baseURL}`);
  console.log(`Model     : ${model}`);
  console.log(`WebSocket : ws://${host}:${port}/ws`);
  console.log(dim('Approval  : enabled (web client will be prompted)'));
  console.log(dim('Press Ctrl+C to stop.\n'));

  const app = await RuntimeApp.create({
    workspaceDir: WORKSPACE_DIR,
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: false },
    },
  });

  const ws = new WebSocketChannel({
    port,
    host,
    approval: true,
  });

  app.registerChannel(ws);

  // Graceful shutdown on Ctrl+C
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write('\n');
    await app.close('user exit');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());

  // start blocks until WebSocketChannel.stop() resolves (called by close())
  await app.startChannels();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mFatal: ${message}\x1b[0m\n`);
  process.exit(1);
});
