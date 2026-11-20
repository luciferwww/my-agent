// Device-flow approach adapted from llm-relay (MIT); see THIRD-PARTY-NOTICES.
import { setTimeout as sleep } from 'node:timers/promises';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB = 'https://github.com';

export class LoginError extends Error {
  constructor(message: string, readonly httpStatus?: number) { super(message); }
}
export class LoginCancelledError extends LoginError {}
export class LoginRequiredError extends LoginError {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,65536}$/.test(value);
}

async function request(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  context = { label: 'Authentication', limit: 65_536 },
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new LoginRequiredError(`${context.label} requires a new GitHub sign-in (HTTP 401).`, 401);
    throw new LoginError(`${context.label} request failed (HTTP ${response.status}).`, response.status);
  }
  if (!response.body) throw new LoginError(`${context.label} response is empty.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > context.limit) {
        await reader.cancel();
        throw new LoginError(`${context.label} response is too large.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new LoginError(`${context.label} response is not valid JSON.`);
  }
  if (!record(value)) throw new LoginError(`${context.label} response is invalid.`);
  return value;
}

export interface AuthOptions {
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}

export const COPILOT_HEADERS = {
  'user-agent': 'my-agent-copilot-login-spike/0.1.0',
  'editor-version': 'vscode/1.98.0',
  'editor-plugin-version': 'copilot-chat/0.20.0',
  'copilot-integration-id': 'vscode-chat',
};

async function copilotAccess(accessToken: string, options: AuthOptions) {
  const value = await request('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      accept: 'application/json',
      authorization: `token ${accessToken}`,
      ...COPILOT_HEADERS,
    },
  }, options.signal, options.fetch ?? fetch);
  if (!secret(value.token) || typeof value.expires_at !== 'number'
    || !Number.isFinite(value.expires_at) || value.expires_at * 1000 <= Date.now()) {
    throw new LoginError('GitHub authorization did not yield usable Copilot access.');
  }
  return { token: value.token, apiBase: record(value.endpoints) ? value.endpoints.api : undefined };
}

export async function verifyCopilot(accessToken: string, options: AuthOptions): Promise<void> {
  await copilotAccess(accessToken, options);
}

export interface CopilotModel {
  readonly modelId: string;
  readonly displayName?: string;
  readonly apiBase: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function getCopilotAccess(accessToken: string, options: AuthOptions): Promise<{ token: string; apiBase: string }> {
  const access = await copilotAccess(accessToken, options);
  let base: URL;
  try {
    if (typeof access.apiBase !== 'string') throw new Error('Missing API endpoint.');
    base = new URL(access.apiBase);
  } catch {
    throw new LoginError('GitHub did not return a valid Copilot API endpoint.');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new LoginError('GitHub did not return a secure Copilot API endpoint.');
  }
  return { token: access.token, apiBase: base.href.replace(/\/$/, '') };
}

export async function discoverCopilotModels(accessToken: string, options: AuthOptions): Promise<readonly CopilotModel[]> {
  const access = await getCopilotAccess(accessToken, options);
  const payload = await request(`${access.apiBase}/models`, {
    headers: {
      ...COPILOT_HEADERS, accept: 'application/json', authorization: `Bearer ${access.token}`,
    },
  }, options.signal, options.fetch ?? fetch, { label: 'Model discovery', limit: 2 * 1024 * 1024 });
  if (!Array.isArray(payload.data)) throw new LoginError('Copilot model discovery must return a data array.');
  const models: CopilotModel[] = [];
  const ids = new Set<string>();
  for (const model of payload.data) {
    if (!record(model) || typeof model.id !== 'string' || !model.id.trim()
      || /[\x00-\x1f\x7f]/.test(model.id) || ids.has(model.id)
      || (model.name !== undefined && (typeof model.name !== 'string' || !model.name.trim()))) {
      throw new LoginError('Copilot returned invalid or duplicate model metadata.');
    }
    ids.add(model.id);
    models.push(Object.freeze({
      modelId: model.id, ...(typeof model.name === 'string' ? { displayName: model.name } : {}),
      apiBase: access.apiBase, metadata: Object.freeze({ ...model }),
    }));
  }
  return Object.freeze(models);
}

export async function deviceLogin(options: AuthOptions & {
  readonly display: (url: string, code: string) => void;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? (async (ms, signal) => { await sleep(ms, undefined, { signal }); });
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  const device = await request(`${GITHUB}/login/device/code`, {
    method: 'POST', headers,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
  }, options.signal, fetchImpl);
  if (!secret(device.device_code) || typeof device.user_code !== 'string'
    || !/^[A-Z0-9-]{1,64}$/.test(device.user_code)
    || device.verification_uri !== `${GITHUB}/login/device`
    || typeof device.expires_in !== 'number' || !Number.isFinite(device.expires_in)
    || device.expires_in <= 0 || device.expires_in > 86_400
    || (device.interval !== undefined && (typeof device.interval !== 'number'
      || !Number.isFinite(device.interval) || device.interval < 0 || device.interval > 60))) {
    throw new LoginError('GitHub returned invalid device authorization instructions.');
  }
  const deadline = now() + device.expires_in * 1000;
  let interval = Math.max(typeof device.interval === 'number' ? device.interval : 5, 1) * 1000;
  options.display(device.verification_uri, device.user_code);
  while (now() < deadline) {
    await wait(Math.min(interval, deadline - now()), options.signal);
    options.signal.throwIfAborted();
    if (now() >= deadline) break;
    const pollSignal = AbortSignal.any([
      options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
    ]);
    const value = await request(`${GITHUB}/login/oauth/access_token`, {
      method: 'POST', headers,
      body: JSON.stringify({
        client_id: CLIENT_ID, device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    }, pollSignal, fetchImpl);
    if (secret(value.access_token)) return value.access_token;
    if (value.error === 'authorization_pending') continue;
    if (value.error === 'slow_down') { interval += 5000; continue; }
    if (value.error === 'expired_token') throw new LoginError('The device code expired. Start login again.');
    if (value.error === 'access_denied') throw new LoginError('GitHub authorization was denied.');
    throw new LoginError('GitHub device authorization failed.');
  }
  throw new LoginError('The device code expired. Start login again.');
}
