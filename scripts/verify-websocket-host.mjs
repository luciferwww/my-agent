import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import {
  assertTreeUnchanged,
  createIsolatedHomeEnvironment,
  snapshotTree,
} from './verify-npm-package.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_ENTRY = join(REPOSITORY_ROOT, 'dist', 'host', 'hosts', 'standalone', 'entry.js');
const EXTENSIONS_ROOT = join(REPOSITORY_ROOT, 'extensions');
const API_KEY = 'websocket-host-smoke-secret';
const MODEL_ID = 'smoke-model';
const TIMEOUT_MS = 15_000;
const HOST_START_TIMEOUT_MS = 60_000;

async function main() {
  await assertBuildInputs();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'my-agent-websocket-host-'));
  const homeDirectory = join(temporaryRoot, 'home');
  const agentHome = join(homeDirectory, '.my-agent');
  const startupCwd = join(temporaryRoot, 'startup-cwd');
  let endpoint;
  let child;
  let client;
  let failure;
  let failed = false;
  const output = [];

  try {
    await Promise.all([
      mkdir(agentHome, { recursive: true }),
      mkdir(startupCwd, { recursive: true }),
    ]);
    endpoint = await startLoopbackModel();
    const webSocketPort = await findAvailableLoopbackPort();
    await createAgentHome(agentHome, webSocketPort, endpoint.baseURL);
    const installationBefore = await snapshotTree(EXTENSIONS_ROOT);
    const startupCwdBefore = await snapshotTree(startupCwd);
    child = startHost(homeDirectory, startupCwd, output);

    client = await connectWithRetry(`ws://127.0.0.1:${webSocketPort}/ws`, child);
    const messages = createMessageQueue(client);
    client.send(JSON.stringify({ type: 'hello', clientId: 'host-smoke' }));
    const hello = await messages.next((message) => message.type === 'hello_ack');
    assert(hello.clientId === 'host-smoke', 'Host returned an unexpected hello acknowledgement.');

    client.send(JSON.stringify({
      type: 'create_session',
      requestId: 'host-smoke-session',
    }));
    const session = await messages.next((message) =>
      message.type === 'session_created' && message.requestId === 'host-smoke-session');

    client.send(JSON.stringify({
      type: 'run_turn',
      sessionId: session.sessionId,
      message: 'Reply with exactly: smoke ok',
      reasoning: { effort: 'high' },
    }));

    const text = [];
    let result;
    while (!result) {
      const message = await messages.next((candidate) =>
        candidate.type === 'text_delta' || candidate.type === 'run_end');
      if (message.type === 'text_delta') text.push(message.text);
      else result = message.result;
    }

    assert(text.join('') === 'smoke ok', 'Host did not stream the loopback model response.');
    assert(result?.text === 'smoke ok', 'Host returned an unexpected final response.');
    assert(result?.stopReason === 'end_turn', 'Host returned an unexpected stop reason.');
    assert(endpoint.requests.responses === 1, 'Host did not invoke the model endpoint exactly once.');
    assert(endpoint.requests.authorizationValid, 'Host did not materialize the configured API key.');
    assert(endpoint.requests.requestedModel === MODEL_ID, 'Host invoked an unexpected model.');
    assert(
      endpoint.requests.requestedReasoningEffort === 'high',
      'Host did not forward the selected reasoning effort.',
    );
    assert(!output.join('').includes(API_KEY), 'Host output retained the configured API key.');
    await stopHostProcess(child);
    child = undefined;
    await Promise.all([
      access(join(agentHome, 'config.json')),
      access(join(agentHome, 'IDENTITY.md')),
      access(join(agentHome, 'SOUL.md')),
      access(join(agentHome, 'AGENTS.md')),
      access(join(agentHome, 'TOOLS.md')),
      access(join(agentHome, 'memory.sqlite')),
    ]);
    assertTreeUnchanged(
      installationBefore,
      await snapshotTree(EXTENSIONS_ROOT),
      'Installed Extension tree',
    );
    assertTreeUnchanged(
      startupCwdBefore,
      await snapshotTree(startupCwd),
      'Startup CWD',
    );

    console.log('Verified generic WebSocket Host with Built-in model invocation, install-owned Channel acquisition and immutable installation contents.');
  } catch (error) {
    const logs = redact(output.join(''), [API_KEY, temporaryRoot]);
    if (logs.trim()) console.error(`Host output:\n${logs.trimEnd()}`);
    failed = true;
    failure = error;
  } finally {
    const cleanupErrors = [];
    try {
      client?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (child) {
      await attemptCleanup(() => stopHostProcess(child), cleanupErrors);
    }
    if (endpoint) {
      await attemptCleanup(() => endpoint.close(), cleanupErrors);
    }
    await attemptCleanup(
      () => rm(temporaryRoot, { recursive: true, force: true }),
      cleanupErrors,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'WebSocket Host verification cleanup failed.',
      );
    }
  }
  if (failed) throw failure;
}

async function assertBuildInputs() {
  await Promise.all([
    readFile(join(EXTENSIONS_ROOT, 'websocket-channel', 'extension.json')),
    readFile(HOST_ENTRY),
    readFile(join(REPOSITORY_ROOT, 'dist', 'host', 'extension', 'api', 'index.js')),
  ]).catch(() => {
    throw new Error('WebSocket Host verification requires a successful npm run build first.');
  });
}

async function createAgentHome(agentHome, webSocketPort, modelBaseURL) {
  await writeFile(join(agentHome, 'config.json'), `${JSON.stringify({
    llm: {
      defaultModel: {
        providerId: 'builtin',
        modelId: MODEL_ID,
      },
      builtin: {
        baseURL: `${modelBaseURL}/v1`,
        apiKey: '${MY_AGENT_SMOKE_API_KEY}',
        models: [{
          modelId: MODEL_ID, protocol: 'openai-responses',
          maximumPromptTokens: 100_000, maximumOutputTokens: 256,
          reasoning: { efforts: ['high'] },
        }],
      },
    },
    extensions: {
      entries: {
        'copilot-provider': { enabled: false },
        'websocket-channel': {
          config: {
            port: webSocketPort,
          },
        },
      },
    },
  }, null, 2)}\n`);
}

async function findAvailableLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('WebSocket smoke port is unavailable.');
  }
  const { port } = address;
  server.close();
  await once(server, 'close');
  return port;
}

function startHost(homeDirectory, startupCwd, output) {
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: startupCwd,
    env: createIsolatedHomeEnvironment(homeDirectory, {
      ...process.env,
      MY_AGENT_SMOKE_API_KEY: API_KEY,
    }),
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

async function startLoopbackModel() {
  const requests = {
    responses: 0,
    authorizationValid: true,
    requestedModel: undefined,
    requestedReasoningEffort: undefined,
  };
  const server = createServer(async (request, response) => {
    requests.authorizationValid &&= request.headers.authorization === `Bearer ${API_KEY}`;
    if (request.method === 'POST' && request.url === '/v1/responses') {
      requests.responses += 1;
      const body = await readRequestBody(request);
      const parsedBody = JSON.parse(body);
      requests.requestedModel = parsedBody.model;
      requests.requestedReasoningEffort = parsedBody.reasoning?.effort;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.end([
        'data: {"type":"response.created","response":{"id":"smoke-response"}}',
        '',
        'data: {"type":"response.output_text.delta","delta":"smoke ok"}',
        '',
        'data: {"type":"response.completed","response":{"id":"smoke-response","status":"completed","usage":{"input_tokens":1,"output_tokens":2}}}',
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
  if (!address || typeof address === 'string') throw new Error('Model endpoint address is unavailable.');
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function connectWithRetry(url, child) {
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
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


async function attemptCleanup(action, errors) {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

await main();
