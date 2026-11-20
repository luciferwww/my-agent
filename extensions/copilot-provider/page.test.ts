/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageHtml, pageScript } from './page.js';

let current: {
  state: string;
  message: string;
  busy: boolean;
  saved: boolean;
  needsLogin?: boolean;
  authorization?: { url: string; code: string };
};
const waiting = {
  state: 'waiting-authorization', message: 'Waiting for GitHub authorization.',
  busy: true, saved: false,
  authorization: { url: 'https://github.com/login/device', code: 'ABCD-1234' },
};
let events: ReadableStreamDefaultController<Uint8Array>;
function publish() {
  events.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(current)}\n\n`));
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing page element: ${id}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState(null, '', '/#synthetic-page-key');
  const template = document.createElement('template');
  template.innerHTML = pageHtml;
  template.content.querySelector('script')?.remove();
  document.body.replaceChildren(template.content);
  current = { state: 'signed-out', message: 'No saved credential.', busy: false, saved: false };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/events') {
      return new Response(new ReadableStream({
        start(controller) {
          events = controller;
          publish();
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      }));
    }
    if (init?.method === 'POST' && url === '/api/login') current = { ...waiting };
    if (init?.method === 'POST' && url === '/api/cancel') {
      current = { state: 'cancelled', message: 'Login cancelled.', busy: false, saved: false };
    }
    if (init?.method === 'POST' && url === '/api/logout') {
      current = { state: 'signed-out', message: 'Signed out on this device.', busy: false, saved: false };
    }
    if (init?.method === 'POST') publish();
    return new Response(JSON.stringify(current));
  }));
  new Function(pageScript)();
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  sessionStorage.clear();
});

describe('device authorization panel', () => {
  it('starts hidden, then shows a copyable code and a user-clicked GitHub link without navigating', async () => {
    await vi.waitFor(() => expect(element('account-action').hasAttribute('disabled')).toBe(false));
    expect(element('authorization').hidden).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    element('account-action').click();
    await vi.waitFor(() => expect(element('authorization').hidden).toBe(false));
    expect(element('device-code').textContent).toBe('ABCD-1234');
    expect(element('github-link').getAttribute('href')).toBe('https://github.com/login/device');
    expect(element('github-link').getAttribute('target')).toBe('_blank');
    expect(location.pathname).toBe('/');
    element('copy-code').click();
    await vi.waitFor(() => expect(element('copy-code').textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
  });

  it('cancels from the original page and removes the stale code and link', async () => {
    await vi.waitFor(() => expect(element('account-action').hasAttribute('disabled')).toBe(false));
    element('account-action').click();
    await vi.waitFor(() => expect(element('account-action').textContent).toBe('Cancel'));
    element('account-action').click();
    await vi.waitFor(() => expect(element('status').textContent).toContain('cancelled'));
    expect(element('authorization').hidden).toBe(true);
    expect(element('device-code').textContent).toBe('');
    expect(element('github-link').hasAttribute('href')).toBe(false);
    expect(element('account-action').hasAttribute('disabled')).toBe(false);
    expect(element('account-action').textContent).toBe('Sign in with GitHub');
  });

  it('hides expired instructions and reports clipboard failures instead of claiming a copy succeeded', async () => {
    await vi.waitFor(() => expect(element('account-action').hasAttribute('disabled')).toBe(false));
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard unavailable'));
    element('account-action').click();
    await vi.waitFor(() => expect(element('authorization').hidden).toBe(false));
    element('copy-code').click();
    await vi.waitFor(() => expect(element('error').textContent).toContain('manually'));
    expect(element('copy-code').textContent).toBe('Copy code');
    current = { state: 'failed', message: 'Device code expired.', busy: false, saved: false };
    publish();
    await vi.waitFor(() => expect(element('authorization').hidden).toBe(true));
    expect(element('device-code').textContent).toBe('');
    expect(element('github-link').hasAttribute('href')).toBe(false);
  });

  it('disconnects its page lifetime and hides the code when the page closes', async () => {
    await vi.waitFor(() => expect(element('account-action').hasAttribute('disabled')).toBe(false));
    element('account-action').click();
    await vi.waitFor(() => expect(element('authorization').hidden).toBe(false));
    const stream = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/events');
    expect(stream?.[1]?.signal?.aborted).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(stream?.[1]?.signal?.aborted).toBe(true);
    expect(element('authorization').hidden).toBe(true);
    expect(element('account-action').hasAttribute('disabled')).toBe(true);
  });

  it('switches the same button to Sign out when connected, then back to Sign in after removing the account', async () => {
    await vi.waitFor(() => expect(element('account-action').hasAttribute('disabled')).toBe(false));
    current = { state: 'verified', message: 'Your account is connected.', busy: false, saved: true };
    publish();
    await vi.waitFor(() => expect(element('account-action').textContent).toBe('Sign out'));
    expect(element('status-title').textContent).toBe('Connected to GitHub Copilot');
    expect(element('account-action').className).toBe('danger');
    expect(element('authorization').hidden).toBe(true);
    element('account-action').click();
    await vi.waitFor(() => expect(element('account-action').textContent).toBe('Sign in with GitHub'));
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
      url === '/api/logout' && options?.method === 'POST')).toBe(true);
    expect(element('status-title').textContent).toBe('Not connected');
  });

  it('offers fresh Sign in instead of Sign out when a stored credential needs reauthorization', async () => {
    await vi.waitFor(() => expect(element('account-action').hasAttribute('disabled')).toBe(false));
    current = {
      state: 'signed-out', message: 'Sign in to continue loading models.',
      busy: false, saved: true, needsLogin: true,
    };
    publish();
    await vi.waitFor(() => expect(element('account-action').textContent).toBe('Sign in with GitHub'));
    element('account-action').click();
    await vi.waitFor(() => expect(element('authorization').hidden).toBe(false));
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
      url === '/api/login' && options?.method === 'POST')).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/logout')).toBe(false);
    current = {
      state: 'cancelled', message: 'Sign-in cancelled.',
      busy: false, saved: true, needsLogin: true,
    };
    publish();
    await vi.waitFor(() => expect(element('status-title').textContent).toBe('Sign-in cancelled'));
    expect(element('account-action').textContent).toBe('Sign in with GitHub');
  });
});
