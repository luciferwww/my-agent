// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import ClientApp from './App.vue';

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  callbacks: undefined as undefined | {
    onStatusChange(status: string): void;
    onMessage(data: string): void;
    onClose(detail: string): void;
  },
}));

vi.mock('./client/socket', () => ({
  configuredWebSocketUrl: () => 'ws://localhost/ws',
  SocketClient: class {
    constructor(_url: string, callbacks: NonNullable<typeof socket.callbacks>) {
      socket.callbacks = callbacks;
    }
    start() {}
    stop() {}
    markConnected() {}
    sendJson(payload: unknown) { socket.send(payload); }
  },
}));

let app: App;
let host: HTMLDivElement;

function receive(message: object) {
  if (!socket.callbacks) throw new Error('Socket not initialized.');
  socket.callbacks.onMessage(JSON.stringify(message));
}

function requests(): { type: string; requestId: string }[] {
  return socket.send.mock.calls.map(([payload]) => payload)
    .filter(payload => payload.type === 'get_model_catalog');
}

async function togglePicker() {
  const trigger = host.querySelector<HTMLButtonElement>('.composer .model-picker-trigger');
  if (!trigger) throw new Error('Missing model picker.');
  expect(trigger.disabled).toBe(false);
  trigger.click();
  await nextTick();
}

function lastRequest(type: string): { type: string; requestId: string; sessionId?: string } {
  const request = socket.send.mock.calls.map(([payload]) => payload)
    .filter(payload => payload.type === type).at(-1);
  if (!request) throw new Error(`Missing ${type} request.`);
  return request;
}

function button(selector: string, label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>(selector)]
    .find(candidate => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label);
  if (!element) throw new Error(`Missing ${label} button.`);
  return element;
}

async function selectSession(title: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>('.session-select-button')]
    .find(candidate => candidate.textContent?.includes(title));
  if (!element) throw new Error(`Missing ${title} Session.`);
  element.click();
  await nextTick();
  const request = socket.send.mock.calls.at(-1)?.[0];
  if (request?.type === 'unsubscribe_session') {
    receive({ ...request, type: 'session_unsubscribed' });
  }
  receive({ ...lastRequest('subscribe_session'), type: 'session_subscribed' });
  await nextTick();
}

async function prepareApprovalSession(models = [{ modelId: 'model', capabilities: {
  reasoning: { thinking: ['on', 'off'], efforts: ['low', 'high'] },
} }]) {
  vi.setSystemTime(60_000);
  await togglePicker();
  receive({
    type: 'model_catalog', requestId: requests().at(-1)!.requestId,
    catalog: {
      generation: 2, defaultSelection: { state: 'unset' },
      providers: [{
        providerId: 'builtin', displayName: 'Built-in',
        models,
      }],
    },
  });
  receive({
    type: 'sessions_listed', requestId: lastRequest('list_sessions').requestId,
    sessions: [
      { sessionId: 'root', title: 'Root Session', updatedAt: 1 },
      { sessionId: 'other', title: 'Other Session', updatedAt: 2 },
    ],
  });
  await nextTick();
  await selectSession('Root Session');
}

function approval(id: string, sessionId = 'root') {
  receive({
    type: 'approval_requested', id, sessionId, turnId: `turn-${id}`,
    callId: `call-${id}`, toolName: 'exec', input: { command: `echo ${id}` },
  });
}

const preferenceModels = ['alpha', 'beta'].map(modelId => ({
  modelId,
  capabilities: { reasoning: { thinking: ['on', 'off'], efforts: ['none', 'low', 'high'] } },
}));

async function selectModel(modelId: string) {
  await togglePicker();
  const option = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Select model"] button')]
    .find(candidate => candidate.textContent?.includes(modelId));
  if (!option) throw new Error(`Missing ${modelId} model option.`);
  option.click();
  await nextTick();
}

async function selectReasoning(thinking: string, effort: string) {
  for (const [prefix, value] of [['Reasoning effort:', effort], ['Thinking:', thinking]]) {
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('.reasoning-picker-trigger')]
      .find(candidate => candidate.getAttribute('aria-label')?.startsWith(prefix));
    if (!trigger) throw new Error(`Missing ${prefix} picker.`);
    trigger.click();
    await nextTick();
    button('button', value).click();
    await nextTick();
  }
}

function expectSelection(modelId: string, thinking: string, effort: string) {
  expect(host.querySelector('.composer .model-picker-trigger')?.textContent).toContain(modelId);
  expect(host.querySelector(`.composer [aria-label="Thinking: ${thinking}"]`)).not.toBeNull();
  expect(host.querySelector(`.composer [aria-label="Reasoning effort: ${effort}"]`)).not.toBeNull();
}

async function startNewSession() {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="New Session"]');
  if (!trigger) throw new Error('Missing New Session button.');
  trigger.click();
  await nextTick();
  const request = socket.send.mock.calls.at(-1)?.[0];
  if (request?.type === 'unsubscribe_session') receive({ ...request, type: 'session_unsubscribed' });
  await nextTick();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  socket.send.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ClientApp);
  app.mount(host);
  socket.callbacks!.onStatusChange('connected');
  receive({ type: 'hello_ack', clientId: 'client' });
  receive({
    type: 'model_catalog', requestId: requests()[0].requestId,
    catalog: { generation: 1, defaultSelection: { state: 'unset' }, providers: [] },
  });
  await nextTick();
});

afterEach(() => {
  app.unmount();
  host.remove();
  vi.useRealTimers();
});

describe('display-time model catalogs', () => {
  it('can reopen an empty picker and queries at exactly 60 seconds, coalescing pending reads', async () => {
    vi.setSystemTime(59_999);
    await togglePicker();
    expect(document.querySelector('[aria-label="Select model"]')).not.toBeNull();
    expect(requests()).toHaveLength(1);
    await togglePicker();
    vi.setSystemTime(60_000);
    await togglePicker();
    expect(requests()).toHaveLength(2);
    await togglePicker();
    await togglePicker();
    expect(requests()).toHaveLength(2);
  });

  it('settles a correlated query error and permits another display-time attempt after 60 seconds', async () => {
    vi.setSystemTime(60_000);
    await togglePicker();
    receive({
      type: 'channel_error', requestId: requests()[1].requestId,
      code: 'CATALOG_FAILED', message: 'Catalog unavailable',
    });
    await nextTick();
    expect(host.textContent).toContain('Catalog unavailable');
    await togglePicker();
    vi.setSystemTime(119_999);
    await togglePicker();
    expect(requests()).toHaveLength(2);
    await togglePicker();
    vi.setSystemTime(120_000);
    await togglePicker();
    expect(requests()).toHaveLength(3);
  });
});

describe('approval composer mode', () => {
  it('replaces input and upload controls with the approval card and footer actions, then restores the draft', async () => {
    await prepareApprovalSession();
    const textarea = host.querySelector('textarea')!;
    textarea.value = 'Keep this draft';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await togglePicker();
    approval('a');
    await nextTick();
    const composer = host.querySelector('.composer')!;
    const card = composer.querySelector('.approval-deck')!;
    expect(card).not.toBeNull();
    expect(composer.querySelector('textarea')).toBeNull();
    expect(composer.querySelector('input[type="file"]')).toBeNull();
    expect(composer.querySelector('.composer-hint')).toBeNull();
    expect(card.querySelector('.approval-actions')).toBeNull();
    expect([...composer.querySelectorAll<HTMLButtonElement>('.approval-actions button')]
      .map(action => action.textContent?.trim())).toEqual(['Stop', 'Deny', 'Allow']);
    expect(host.querySelector('.chat-log')?.closest('[inert]')).toBeNull();
    expect(document.querySelector('[aria-label="Select model"]')).toBeNull();
    expect(host.querySelector('.composer .model-picker-trigger')).toBeNull();
    expect(host.querySelector('.reasoning-picker-trigger')).toBeNull();

    approval('b');
    await nextTick();
    expect(host.querySelector('[data-approval-id]')?.getAttribute('data-approval-id')).toBe('a');
    button('.approval-deck-navigation button', 'Next approval').click();
    await nextTick();
    button('.approval-actions button', 'Allow').click();
    expect(socket.send).toHaveBeenCalledWith({ type: 'approval_resolve', id: 'b', decision: 'allow' });
    receive({
      type: 'approval_closed', id: 'b', sessionId: 'root', turnId: 'turn-b', callId: 'call-b',
      outcome: 'approved', reason: 'user',
    });

    await nextTick();
    expect(host.querySelector('[data-approval-id]')?.getAttribute('data-approval-id')).toBe('a');
    button('.approval-actions button', 'Stop').click();
    expect(socket.send).toHaveBeenCalledWith({ type: 'abort_turn', sessionId: 'root' });
    expect(composer.querySelector('textarea')).toBeNull();
    receive({
      type: 'approval_closed', id: 'a', sessionId: 'root', turnId: 'turn-a', callId: 'call-a',
      outcome: 'cancelled', reason: 'abort',
    });
    await nextTick();
    expect(composer.querySelector('.approval-deck')).toBeNull();
    expect(composer.querySelector('textarea')?.value).toBe('Keep this draft');
    expect(composer.querySelector('input[type="file"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.composer .model-picker-trigger')?.disabled).toBe(false);
  });

  it('keeps session switching usable and scopes the replacement and disabled actions to pending approvals', async () => {
    await prepareApprovalSession();
    approval('other-approval', 'other');
    await nextTick();
    expect(host.querySelector('.composer textarea')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.composer .model-picker-trigger')?.disabled).toBe(false);
    host.querySelector<HTMLButtonElement>('[aria-label="Reasoning effort: Default"]')!.click();
    await nextTick();
    expect(document.querySelector('[aria-label="Reasoning effort options"]')).not.toBeNull();
    approval('a');
    await nextTick();
    expect(document.querySelector('[aria-label="Reasoning effort options"]')).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>('.session-select-button')]
      .every(trigger => !trigger.disabled)).toBe(true);
    await selectSession('Other Session');
    expect(host.querySelector('[data-approval-id]')?.getAttribute('data-approval-id')).toBe('other-approval');
    button('.approval-actions button', 'Deny').click();
    expect(socket.send).toHaveBeenCalledWith({
      type: 'approval_resolve', id: 'other-approval', decision: 'deny',
    });
    receive({
      type: 'approval_closed', id: 'other-approval', sessionId: 'other',
      turnId: 'turn-other-approval', callId: 'call-other-approval', outcome: 'denied', reason: 'user',
    });
    await nextTick();
    expect(host.querySelector('.composer textarea')).not.toBeNull();
    await selectSession('Root Session');
    expect(host.querySelector('[data-approval-id]')?.getAttribute('data-approval-id')).toBe('a');
    socket.callbacks!.onStatusChange('disconnected');
    await nextTick();
    expect([...host.querySelectorAll<HTMLButtonElement>('.approval-actions button')]
      .every(trigger => trigger.disabled)).toBe(true);
  });
});

describe('session-scoped composer preferences', () => {
  it('restores independent session choices and lets new sessions inherit a separate snapshot', async () => {
    await prepareApprovalSession(preferenceModels);
    await selectModel('beta');
    await selectReasoning('On', 'High');
    await selectSession('Other Session');
    await selectReasoning('Off', 'None');
    expectSelection('alpha', 'Off', 'None');
    await selectSession('Root Session');
    expectSelection('beta', 'On', 'High');
    await startNewSession();
    expectSelection('beta', 'On', 'High');
    await selectModel('alpha');
    await selectReasoning('Off', 'None');
    await selectSession('Root Session');
    expectSelection('beta', 'On', 'High');
    await selectSession('Other Session');
    expectSelection('alpha', 'Off', 'None');
  });

  it('keeps inherited choices through session creation and snapshots them in the first run', async () => {
    await prepareApprovalSession(preferenceModels);
    await selectModel('beta');
    await selectReasoning('On', 'High');
    await startNewSession();
    expect(socket.send.mock.calls.filter(([payload]) => payload.type === 'create_session')).toHaveLength(0);
    const textarea = host.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    expect(textarea.placeholder).toContain('Press Enter to send or Shift+Enter for a new line.');
    expect(textarea.placeholder).toContain('Attach up to 20 images (10 MB total) by button, drop, or paste.');
    expect(host.querySelector('.composer-hint')).toBeNull();
    expect(host.querySelector('.sidebar [aria-label="Select model"]')).toBeNull();
    textarea.value = 'Test preference snapshot';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const send = [...host.querySelectorAll<HTMLButtonElement>('.composer button')]
      .find(candidate => candidate.textContent?.trim().endsWith('Send'));
    if (!send) throw new Error('Missing Send button.');
    send.click();
    await nextTick();
    receive({ type: 'session_created', requestId: lastRequest('create_session').requestId, sessionId: 'created' });
    await nextTick();
    expectSelection('beta', 'On', 'High');
    expect(socket.send).toHaveBeenCalledWith({
      type: 'run_turn', sessionId: 'created', message: 'Test preference snapshot',
      modelReference: { providerId: 'builtin', modelId: 'beta' },
      reasoning: { thinking: 'on', effort: 'high' },
    });
  });

  it('reconciles inactive choices against new capabilities and preserves valid choices through reconnect', async () => {
    await prepareApprovalSession(preferenceModels);
    await selectModel('beta');
    await selectReasoning('On', 'High');
    await selectSession('Other Session');
    await selectReasoning('Off', 'None');
    socket.callbacks!.onClose('Disconnected for test');
    socket.callbacks!.onStatusChange('connected');
    receive({ type: 'hello_ack', clientId: 'client' });
    receive({ ...lastRequest('subscribe_session'), type: 'session_subscribed' });
    receive({
      type: 'model_catalog', requestId: requests().at(-1)!.requestId,
      catalog: { generation: 3, defaultSelection: { state: 'unset' }, providers: [{
        providerId: 'builtin', displayName: 'Built-in', models: preferenceModels,
      }] },
    });
    await nextTick();
    expectSelection('alpha', 'Off', 'None');
    vi.setSystemTime(120_000);
    await togglePicker();
    receive({
      type: 'model_catalog', requestId: requests().at(-1)!.requestId,
      catalog: { generation: 4, defaultSelection: { state: 'unset' }, providers: [{
        providerId: 'builtin', displayName: 'Built-in',
        models: [{ modelId: 'alpha', capabilities: {
          reasoning: { thinking: ['on'], efforts: ['low'] },
        } }],
      }] },
    });
    await nextTick();
    expectSelection('alpha', 'Default', 'Default');
    await selectSession('Root Session');
    expectSelection('alpha', 'On', 'Default');
    expect(host.textContent).not.toContain('reset to Default because the selected model');
  });
});
