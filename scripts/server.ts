/**
 * WebSocket server entry point built on the Channel layer.
 *
 * Boots a RuntimeApp and exposes it via WebSocketChannel with approval enabled,
 * meant to be paired with the web client at clients/html/chat.html.
 *
 * Usage:
 *   npx tsx scripts/server.ts
 *   npx tsx scripts/server.ts --port=9000
 *
 * Env vars (optional):
 *   COPILOT_RELAY_BASE_URL (default: 'http://127.0.0.1:5000')
 *   COPILOT_RELAY_API_KEY  (default: no Authorization header)
 *   MY_AGENT_MODEL         (default: 'gpt-5.6-sol')
 *   MY_AGENT_WS_PORT       (default: 8787)
 *   MY_AGENT_WS_HOST       (default: '127.0.0.1')
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COPILOT_RELAY_PROVIDER_ID,
  DEFAULT_COPILOT_RELAY_BASE_URL,
  createCopilotRelayProviderUnit,
  normalizeCopilotRelayBaseURL,
} from '../src/extensions/copilot-relay-provider/index.js';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import { createWebSocketChannelModule } from '../src/runtime-modules/index.js';
import { createRuntimeHost } from './runtime-host.js';

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
  const apiKey = process.env.COPILOT_RELAY_API_KEY;
  const baseURL = normalizeCopilotRelayBaseURL(
    process.env.COPILOT_RELAY_BASE_URL ?? DEFAULT_COPILOT_RELAY_BASE_URL,
  );
  const model = process.env.MY_AGENT_MODEL ?? 'gpt-5.6-sol';
  const port = parseIntArg('port', Number.parseInt(process.env.MY_AGENT_WS_PORT ?? '8787', 10) || 8787);
  const host = process.env.MY_AGENT_WS_HOST ?? '127.0.0.1';

  console.log(bold('\n=== my-agent WebSocket server ==='));
  console.log(`Workspace : ${WORKSPACE_DIR}`);
  console.log(`Provider  : ${COPILOT_RELAY_PROVIDER_ID}`);
  console.log(`Relay     : ${new URL(baseURL).origin}`);
  console.log(`Model     : ${COPILOT_RELAY_PROVIDER_ID}/${model}`);
  console.log(`WebSocket : ws://${host}:${port}/ws`);
  console.log(dim('Approval  : enabled (web client will be prompted)'));
  console.log(dim('Press Ctrl+C to stop.\n'));

  const app = await RuntimeApp.create({
    workspaceDir: WORKSPACE_DIR,
    loadedUnits: [
      createCopilotRelayProviderUnit({ baseURL, apiKey }),
      createWebSocketChannelModule({
        port,
        host,
        approval: true,
      }),
    ],
    envOverrides: {
      model: { providerId: COPILOT_RELAY_PROVIDER_ID, modelId: model },
      memory: { enabled: true },
    },
  });

  console.log(`Tools     : ${app.application.getToolNames().join(', ')}`);
  const runtimeHost = createRuntimeHost(app);

  const completion = await app.application.waitForChannelCompletion('websocket');
  await runtimeHost.shutdown(
    completion.outcome === 'failed' ? 'websocket channel failed' : 'websocket closed',
  );
  if (completion.outcome === 'failed') throw completion.error;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31mFatal: ${message}\x1b[0m\n`);
  process.exitCode = 1;
});
