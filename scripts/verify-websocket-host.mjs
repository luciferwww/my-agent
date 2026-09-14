import { once } from 'node:events';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT_ROOT = join(
  REPOSITORY_ROOT,
  'dist',
  'extension-artifacts',
  'copilot-relay-provider',
);
const HOST_ENTRY = join(REPOSITORY_ROOT, 'scripts', 'server.ts');
const API_KEY = 'websocket-host-smoke-secret';
const MODEL_ID = 'smoke-model';
const TIMEOUT_MS = 15_000;

async function main() {
  await assertBuildInputs();
  const agentHome = await mkdtemp(join(tmpdir(), 'my-agent-websocket-host-'));
  let relay;
  let child;
  let client;
  const output = [];

  try {
    relay = await startLoopbackRelay();
    const webSocketPort = await reserveLoopbackPort();
    await createAgentHome(agentHome, relay.baseURL);
    child = startHost(agentHome, webSocketPort, relay.baseURL, output);

    client = await connectWithRetry(`ws://127.0.0.1:${webSocketPort}/ws`, child);
    const messages = createMessageQueue(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'host-smoke' }));
    const hello = await messages.next((message) => message.type === 'hello_ack');
    assert(hello.clientId === 'host-smoke', 'Host returned an unexpected hello acknowledgement.');

    client.send(JSON.stringify({
      type: 'run_turn',
      sessionKey: 'main',
      message: 'Reply with exactly: smoke ok',
      model_reference: { provider_id: 'copilot-relay', model_id: MODEL_ID },
      request_override: { max_output_tokens: 32 },
      maxLlmCalls: 1,
    }));

    const text = [];
    let result;
    while (!result) {
      const message = await messages.next((candidate) =>
        candidate.type === 'text_delta' || candidate.type === 'run_end');
      if (message.type === 'text_delta') text.push(message.text);
      else result = message.result;
    }

    assert(text.join('') === 'smoke ok', 'Host did not stream the loopback Relay response.');
    assert(result?.text === 'smoke ok', 'Host returned an unexpected final response.');
    assert(result?.stopReason === 'end_turn', 'Host returned an unexpected stop reason.');
    assert(relay.requests.models === 1, 'Host did not discover the Relay model catalog exactly once.');
    assert(relay.requests.responses === 1, 'Host did not invoke the Relay exactly once.');
    assert(relay.requests.authorizationValid, 'Host did not materialize the configured API key.');
    assert(relay.requests.requestedModel === MODEL_ID, 'Host invoked an unexpected Relay model.');
    assert(!output.join('').includes(API_KEY), 'Host output retained the configured API key.');

    console.log('Verified generic WebSocket Host acquisition with the relocated Relay artifact.');
  } catch (error) {
    const logs = redact(output.join(''), [API_KEY, agentHome]);
    if (logs.trim()) console.error(`Host output:\n${logs.trimEnd()}`);
    throw error;
  } finally {
    client?.close();
    if (child) await stopHostProcess(child);
    if (relay) await relay.close();
    await rm(agentHome, { recursive: true, force: true });
  }
}

async function assertBuildInputs() {
  await Promise.all([
    readFile(join(ARTIFACT_ROOT, 'extension.json')),
    readFile(HOST_ENTRY),
  ]).catch(() => {
    throw new Error('WebSocket Host verification requires a successful npm run build first.');
  });
}

async function createAgentHome(agentHome, baseURL) {
  const installationRoot = join(agentHome, 'extensions', 'relocated-relay');
  await mkdir(join(agentHome, 'extensions'), { recursive: true });
  await cp(ARTIFACT_ROOT, installationRoot, { recursive: true });
  await writeFile(join(agentHome, 'config.json'), `${JSON.stringify({
    extensions: {
      enabled: true,
      entries: {
        'copilot-relay-provider': {
          enabled: true,
          config: {
            baseURL: { $env: 'COPILOT_RELAY_BASE_URL' },
            apiKey: {
              $secret: { source: 'env', name: 'COPILOT_RELAY_API_KEY' },
            },
            discoveryTimeoutMs: 5_000,
          },
        },
      },
    },
  }, null, 2)}\n`);
}

function startHost(agentHome, port, relayBaseURL, output) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(npx, [
    'tsx',
    HOST_ENTRY,
    '--agent-home',
    agentHome,
    `--port=${port}`,
  ], {
    cwd: REPOSITORY_ROOT,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      COPILOT_RELAY_BASE_URL: relayBaseURL,
      COPILOT_RELAY_API_KEY: API_KEY,
      MY_AGENT_HOME: agentHome,
      MY_AGENT_PROVIDER: 'copilot-relay',
      MY_AGENT_MODEL: MODEL_ID,
      MY_AGENT_WS_HOST: '127.0.0.1',
      MY_AGENT_WS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  return child;
}

async function stopHostProcess(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const result = spawnSync(
      'taskkill',
      ['/pid', String(child.pid), '/t', '/f'],
      { stdio: 'ignore' },
    );
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await waitForChildExit(child, 2_000);
    assertChildExited(child);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForChildExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
  assertChildExited(child);
}

function assertChildExited(child) {
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('WebSocket Host process did not exit after forced cleanup.');
  }
}

async function startLoopbackRelay() {
  const requests = {
    models: 0,
    responses: 0,
    authorizationValid: true,
    requestedModel: undefined,
  };
  const server = createServer(async (request, response) => {
    requests.authorizationValid &&= request.headers.authorization === `Bearer ${API_KEY}`;
    if (request.method === 'GET' && request.url === '/v1/models') {
      requests.models += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: [{
          id: MODEL_ID,
          name: 'Smoke Model',
          supported_endpoints: ['/responses'],
          capabilities: {
            limits: { max_prompt_tokens: 100_000, max_output_tokens: 256 },
            supports: { tool_calls: true, vision: false },
          },
        }],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/responses') {
      requests.responses += 1;
      const body = await readRequestBody(request);
      requests.requestedModel = JSON.parse(body).model;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.end([
        'data: {"type":"response.created"}',
        '',
        'data: {"type":"response.output_text.delta","delta":"smoke ok"}',
        '',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Relay address is unavailable.');
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function reserveLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebSocket address is unavailable.');
  const { port } = address;
  server.close();
  await once(server, 'close');
  return port;
}

async function connectWithRetry(url, child) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('WebSocket Host exited before becoming ready.');
    }
    try {
      return await openWebSocket(url, 500);
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error('WebSocket Host did not become ready.');
}

function openWebSocket(url, timeoutMs) {
  const socket = new WebSocket(url);
  return new Promise((resolveSocket, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket connection timed out.')), timeoutMs);
    timer.unref?.();
    const onOpen = () => finish();
    const onError = (error) => finish(error);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      if (error) {
        socket.terminate();
        reject(error);
      } else {
        resolveSocket(socket);
      }
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

async function waitForChildExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveExit) => setTimeout(resolveExit, milliseconds)),
  ]);
}

function createMessageQueue(socket) {
  const queued = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });
  return {
    async next(predicate) {
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        const message = queued.length > 0
          ? queued.shift()
          : await Promise.race([
              new Promise((resolveMessage) => waiters.push(resolveMessage)),
              timeout(deadline - Date.now(), 'Timed out waiting for a Host message.'),
            ]);
        if (predicate(message)) return message;
      }
      throw new Error('Timed out waiting for a matching Host message.');
    },
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function timeout(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function redact(value, secrets) {
  return secrets.reduce((result, secret) =>
    secret ? result.replaceAll(secret, '<redacted>') : result, value);
}

await main();
