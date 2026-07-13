/**
 * WebSocket channel entry point built on the Channel layer.
 *
 * Uses RuntimeApp + WebSocketChannel:
 *   - RuntimeApp.create() boots the runtime with a fanout closure that delivers
 *     AgentEvents to all registered channels.
 *   - WebSocketChannel accepts `hello`, `run_turn`, and approval messages over WS.
 *
 * Usage:
 *   npx tsx scripts/websocket.ts
 *   npx tsx scripts/websocket.ts --port=3001 --host=127.0.0.1 --path=/ws
 *
 * Env vars (optional):
 *   ANTHROPIC_API_KEY   (default: 'EMPTY')
 *   ANTHROPIC_BASE_URL  (default: 'http://localhost:5000')
 *   MY_AGENT_MODEL      (default: 'gpt-4.1')
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketChannel } from '../src/adapters/channel/index.js';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-workspace');
const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/ws';

function parseStringFlag(name: string, fallback: string): string {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseStringFlag(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  return value;
}

function parseOptionalNumberFlag(name: string): number | undefined {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  if (!arg) return undefined;

  const raw = arg.slice(name.length + 1);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  return value;
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'EMPTY';
  const baseURL = /*process.env.ANTHROPIC_BASE_URL ??*/ 'http://localhost:5000';
  const model = process.env.MY_AGENT_MODEL ?? 'gpt-4.1';
  const port = parseNumberFlag('--port', DEFAULT_PORT);
  const host = parseStringFlag('--host', DEFAULT_HOST);
  const path = parseStringFlag('--path', DEFAULT_PATH);
  const maxClients = parseOptionalNumberFlag('--max-clients');

  console.log(bold('\n=== my-agent WebSocket ==='));
  console.log(`Workspace   : ${WORKSPACE_DIR}`);
  console.log(`Base URL    : ${baseURL}`);
  console.log(`Model       : ${model}`);
  console.log(`WS Endpoint : ws://${host}:${port}${path}`);
  if (maxClients !== undefined) {
    console.log(`Max Clients : ${maxClients}`);
  }
  console.log(dim('Press Ctrl+C to stop the server.\n'));

  const app = await RuntimeApp.create({
    workspaceDir: WORKSPACE_DIR,
    envOverrides: {
      llm: { apiKey, baseURL, model },
      memory: { enabled: false },
    },
  });

  const channel = new WebSocketChannel({
    port,
    host,
    path,
    maxClients,
    approval: true,
  });

  app.registerChannel(channel);

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write('\n');
    await app.close(reason);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('user exit'));
  process.on('SIGTERM', () => void shutdown('process terminated'));

  await app.startChannels();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mFatal: ${message}\x1b[0m\n`);
  process.exit(1);
});