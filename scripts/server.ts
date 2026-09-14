/**
 * WebSocket server entry point built on the Channel layer.
 *
 * Boots a RuntimeApp and exposes it via WebSocketChannel with approval enabled,
 * meant to be paired with the web client at clients/html/chat.html.
 *
 * Usage:
 *   npx tsx scripts/server.ts
 *   npx tsx scripts/server.ts --port=9000
 *   npx tsx scripts/server.ts --agent-home C:\path\to\.my-agent
 *
 * Env vars (optional):
 *   MY_AGENT_HOME          (default: '<user-home>/.my-agent')
 *   MY_AGENT_PROVIDER + MY_AGENT_MODEL (atomic default Model Reference override)
 *   MY_AGENT_WS_PORT       (default: 8787)
 *   MY_AGENT_WS_HOST       (default: '127.0.0.1')
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnvOverrides } from '../src/platform/config/index.js';
import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import { createWebSocketChannelModule } from '../src/runtime-modules/index.js';
import { createRuntimeHost } from './runtime-host.js';
import {
  formatAcquisitionWarning,
  formatRuntimeWarning,
  parseAgentHomeArgument,
  prepareWebSocketHostAcquisition,
} from './websocket-host-startup.js';

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
  const envOverrides = getEnvOverrides();
  const acquisition = await prepareWebSocketHostAcquisition(
    parseAgentHomeArgument(process.argv.slice(2)),
    process.env,
  );
  for (const diagnostic of acquisition.result.diagnostics) {
    const warning = formatAcquisitionWarning(diagnostic);
    if (warning !== undefined) process.stderr.write(`\x1b[33m${warning}\x1b[0m\n`);
  }
  const port = parseIntArg('port', Number.parseInt(process.env.MY_AGENT_WS_PORT ?? '8787', 10) || 8787);
  const host = process.env.MY_AGENT_WS_HOST ?? '127.0.0.1';

  console.log(bold('\n=== my-agent WebSocket server ==='));
  console.log(`Workspace : ${WORKSPACE_DIR}`);
  console.log(`Agent Home: ${acquisition.agentHome}`);
  console.log(`Extensions: ${acquisition.result.loadedUnits.length} loaded`);
  console.log(`WebSocket : ws://${host}:${port}/ws`);
  console.log(dim('Approval  : enabled (web client will be prompted)'));
  console.log(dim('Press Ctrl+C to stop.\n'));

  const app = await RuntimeApp.create({
    workspaceDir: WORKSPACE_DIR,
    loadedUnits: [
      ...acquisition.result.loadedUnits,
      createWebSocketChannelModule({
        port,
        host,
        approval: true,
      }),
    ],
    envOverrides: {
      ...envOverrides,
      memory: { enabled: true },
    },
    onEvent(event) {
      if (event.type === 'warning') {
        process.stderr.write(`\x1b[33m${formatRuntimeWarning(event.info)}\x1b[0m\n`);
      }
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
