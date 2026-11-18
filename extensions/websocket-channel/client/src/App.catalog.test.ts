// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import ClientApp from './App.vue';

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  callbacks: undefined as undefined | {
    onStatusChange(status: string): void;
    onMessage(data: string): void;
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
  const trigger = host.querySelector<HTMLButtonElement>('.model-picker-trigger');
  if (!trigger) throw new Error('Missing model picker.');
  expect(trigger.disabled).toBe(false);
  trigger.click();
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
    expect(host.querySelector('[aria-label="Select model"]')).not.toBeNull();
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
