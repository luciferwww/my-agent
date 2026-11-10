// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import type { SettingsActionResult } from 'my-agent/extension-api';
import { object } from '../client/settings';
import SettingsPanel from './SettingsPanel.vue';

let app: App | undefined;
let host: HTMLDivElement;

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  vi.restoreAllMocks();
});

const catalog = {
  providers: [{ providerId: 'relay', displayName: 'Relay', models: [{ modelId: 'remote', displayName: 'Remote model' }] }],
};

function initialSettings(): Record<string, unknown> {
  return {
    builtin: {
      baseURL: 'https://example.invalid/v1',
      models: ['first', 'second'].map((modelId) => ({ modelId, protocol: 'openai-responses' })),
    },
    defaultModel: { providerId: 'builtin', modelId: 'first' },
  };
}

function section(settings: Record<string, unknown>) {
  return {
    id: 'llm', name: 'LLM', revision: 'revision', restartRequired: false, settings,
    form: { credentials: { '/builtin/apiKey': { configured: settings['builtin'] !== undefined, source: 'environment' } } },
  };
}

async function flush() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function element<T extends Element = HTMLElement>(selector: string, root: ParentNode = host): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

async function click(name: string, root: ParentNode = host) {
  const button = [...root.querySelectorAll('button')]
    .find((button) => button.getAttribute('aria-label') === name || button.textContent?.trim() === name);
  if (!button || button.disabled) throw new Error(`Missing or disabled button: ${name}`);
  button.click();
  await flush();
}

async function fill(name: string, value: string) {
  const label = [...host.querySelectorAll('label')].find((label) => label.firstChild?.textContent?.trim() === name);
  if (!label) throw new Error(`Missing field: ${name}`);
  const input = element<HTMLInputElement | HTMLTextAreaElement>('input, textarea', label);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function mount(settings = initialSettings()) {
  host = document.createElement('div');
  document.body.append(host);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  const state = reactive({ open: false, connected: true });
  let saved = settings;
  const reply = (action: string, input: unknown = {}): SettingsActionResult => {
    if (action === 'update') saved = object(object(input)['settings']);
    return {
      requestId: action, action, ok: true,
      output: action === 'load' ? { sections: [section(saved)], modelCatalog: catalog, diagnostics: [] }
        : action === 'test_llm_model' ? { outcome: 'completed' }
          : { section: section(saved), modelCatalog: catalog },
    };
  };
  const execute = vi.fn<(action: string, input: unknown) => Promise<SettingsActionResult>>(
    async (action, input) => reply(action, input),
  );
  app = createApp({ setup: () => () => h(SettingsPanel, { open: state.open, connected: state.connected, execute }) });
  app.mount(host);
  state.open = true;
  await flush();
  return { execute, state, reply };
}

function rows() {
  return [...host.querySelectorAll<HTMLElement>('.settings-model-item')];
}

function latestUpdate(execute: Awaited<ReturnType<typeof mount>>['execute']) {
  const call = execute.mock.calls.filter(([action]) => action === 'update').at(-1);
  if (!call) throw new Error('No Settings update.');
  return object(call[1]);
}

function deferredResult() {
  let resolve!: (value: SettingsActionResult) => void;
  const promise = new Promise<SettingsActionResult>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('SettingsPanel', () => {
  it('shows the Built-in form without a checkbox and leaves untouched absent configuration absent', async () => {
    const f = await mount({});
    await click('Built-in details');
    expect(element('input[type="url"]')).toBeDefined();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    await click('Save LLM');
    expect(latestUpdate(f.execute)['settings']).toEqual({});
    await fill('Base URL', 'https://new.example.invalid/v1');
    await click('Add model');
    await fill('Model ID', 'new-model');
    await click('Save LLM');
    expect(latestUpdate(f.execute)['settings']).toEqual({
      builtin: { baseURL: 'https://new.example.invalid/v1', models: [{ modelId: 'new-model', protocol: 'openai-responses' }] },
    });
  });

  it('deletes every model without removing the saved URL or credential', async () => {
    const f = await mount();
    await click('Built-in details');
    await click('Delete', rows()[0]);
    await click('Delete', rows()[0]);
    await click('Save LLM');
    expect(latestUpdate(f.execute)).toMatchObject({
      settings: { builtin: { baseURL: 'https://example.invalid/v1', models: [] } },
      credentials: { '/builtin/apiKey': { operation: 'keep' } },
    });
    expect(object(latestUpdate(f.execute)['settings'])).not.toHaveProperty('defaultModel');
  });

  it('keeps collapsed edits and advanced fields and opens a new model immediately', async () => {
    const f = await mount();
    await click('Built-in details');
    expect(host.querySelectorAll('.settings-model')).toHaveLength(0);
    await click('Edit first');
    await fill('Display name (optional)', 'Edited model');
    element<HTMLDetailsElement>('.settings-model details').open = true;
    await fill('Advanced fields', '{"outputTokenLimit":32}');
    await click('Edit second');
    expect(host.querySelectorAll('.settings-model')).toHaveLength(1);
    expect(element<HTMLInputElement>('.settings-model input').value).toBe('second');
    await click('Edit first');
    expect(element<HTMLInputElement>('.settings-model input').value).toBe('first');
    expect(element<HTMLInputElement>('.settings-model label:nth-child(2) input').value).toBe('Edited model');
    await click('Add model');
    expect(host.querySelectorAll('.settings-model')).toHaveLength(1);
    expect(element<HTMLInputElement>('.settings-model input').value).toBe('');
    await fill('Model ID', 'added');
    await click('Save LLM');
    expect(object(object(latestUpdate(f.execute)['settings'])['builtin'])['models']).toEqual([
      { modelId: 'first', displayName: 'Edited model', protocol: 'openai-responses', outputTokenLimit: 32 },
      { modelId: 'second', protocol: 'openai-responses' },
      { modelId: 'added', protocol: 'openai-responses' },
    ]);
  });

  it('marks the draft default across Providers and permits Save LLM from Provider details', async () => {
    const f = await mount();
    await click('Built-in details');
    expect(element('.settings-badge', rows()[0]).textContent).toBe('Default');
    await click('Set default', rows()[1]);
    expect(rows()[0].querySelector('.settings-badge')).toBeNull();
    expect(element('.settings-badge', rows()[1]).textContent).toBe('Default');
    await click('Back to Providers');
    await click('Relay details');
    await click('Set default');
    expect(element('.settings-model-row .settings-badge').textContent).toBe('Default');
    expect(f.execute.mock.calls.filter(([action]) => action === 'update')).toHaveLength(0);
    expect(element('.settings-footer').textContent).toContain('Unsaved changes');
    await click('Save LLM');
    expect(object(latestUpdate(f.execute)['settings'])['defaultModel']).toEqual({ providerId: 'relay', modelId: 'remote' });
  });

  it.each(['load', 'update', 'test_llm_model'])('replaces %s failure with pending feedback and then success', async (action) => {
    const f = await mount();
    await click('Built-in details');
    const trigger = () => action === 'load' ? click('Reload saved settings')
      : action === 'update' ? click('Save LLM') : click('Test', rows()[0]);
    f.execute.mockResolvedValueOnce({
      requestId: action, action, ok: false, error: { code: 'invalid_request', message: 'Old failure.' },
    });
    await trigger();
    expect(element('.settings-feedback-error').textContent).toContain('Old failure.');
    const pending = deferredResult();
    f.execute.mockReturnValueOnce(pending.promise);
    await trigger();
    expect(element('.settings-feedback-pending').textContent).not.toContain('Old failure.');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const input = f.execute.mock.calls.at(-1)?.[1];
    pending.resolve(f.reply(action, input));
    await flush();
    expect(element('.settings-feedback-success').textContent).not.toContain('Old failure.');
    expect(host.querySelectorAll('.settings-feedback')).toHaveLength(1);
  });

  it('reports local validation failures and lets a later default action replace the error', async () => {
    const f = await mount();
    await click('Built-in details');
    await click('Edit first');
    element<HTMLDetailsElement>('.settings-model details').open = true;
    await fill('Advanced fields', '[]');
    await click('Save LLM');
    expect(element('.settings-feedback-error').textContent).toContain('LLM');
    expect(f.execute.mock.calls.filter(([action]) => action === 'update')).toHaveLength(0);
    await click('Set default', rows()[1]);
    expect(host.querySelector('.settings-feedback-error')).toBeNull();
    expect(element('.settings-feedback-info').textContent).toContain('Save LLM');
  });

  it('does not let a late Test result replace a newer disconnect warning', async () => {
    const f = await mount();
    await click('Built-in details');
    const pending = deferredResult();
    f.execute.mockReturnValueOnce(pending.promise);
    await click('Test', rows()[0]);
    f.state.connected = false;
    await flush();
    pending.resolve(f.reply('test_llm_model'));
    await flush();
    expect(element('.settings-feedback-error').textContent).toContain('Disconnected');
    f.state.connected = true;
    await flush();
    expect(element<HTMLButtonElement>('.settings-savebar button').disabled).toBe(true);
    await click('Reload saved settings');
    expect(element('.settings-feedback-success').textContent).toBe('Settings loaded.');
    expect(element<HTMLButtonElement>('.settings-savebar button').disabled).toBe(false);
  });

  it('keeps the fixed footer outside the sidebar grid and groups model actions separately', async () => {
    await mount();
    await click('Built-in details');
    const footer = element('.settings-footer');
    expect(footer.parentElement).toBe(element('dialog'));
    expect(element('.settings-layout').contains(footer)).toBe(false);
    expect(footer.querySelectorAll('.settings-savebar button')).toHaveLength(1);
    expect(element('.settings-content').querySelector('.settings-savebar')).toBeNull();
    expect([...element('.settings-actions', rows()[0]).querySelectorAll('button')].map((button) => button.textContent?.trim()))
      .toEqual(['Test', 'Set default', 'Delete']);
  });
});
