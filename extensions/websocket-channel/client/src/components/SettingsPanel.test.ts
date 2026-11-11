// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import type { SettingsActionResult } from 'my-agent/extension-api';
import { object } from '../client/settings';
import SettingsPanel from './SettingsPanel.vue';

let app: App | undefined;
let host: HTMLDivElement;
const openPopovers = new Set<HTMLElement>();
const nativeMatches = HTMLElement.prototype.matches;
const popoverDescriptors = {
  showPopover: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover'),
  hidePopover: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover'),
};

beforeEach(() => {
  for (const name of ['showPopover', 'hidePopover'] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: function (this: HTMLElement) {
        if (name === 'showPopover') openPopovers.add(this);
        else openPopovers.delete(this);
        this.dispatchEvent(new Event('toggle'));
      },
    });
  }
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) {
    return selector === ':popover-open' ? openPopovers.has(this) : nativeMatches.call(this, selector);
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  vi.restoreAllMocks();
  openPopovers.clear();
  for (const name of ['showPopover', 'hidePopover'] as const) {
    const descriptor = popoverDescriptors[name];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

const catalog = {
  providers: [{ providerId: 'relay', displayName: 'Relay', models: [{ modelId: 'remote', displayName: 'Remote model' }] }],
};
const toolCatalog = [
  { name: 'read_file', description: 'Read file contents.' },
  { name: 'write_file', description: 'Write file contents.' },
  { name: 'edit_file', description: 'Edit file contents.' },
  { name: 'exec', description: 'Execute a command.' },
];

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

function agentSection(id: string, settings: Record<string, unknown> = {}) {
  const builtIn = id === 'general-purpose';
  return {
    id: builtIn ? 'agents:defaults' : `agent:${id}`, name: id, revision: `${id}-revision`,
    kind: builtIn ? 'agent-defaults' : 'agent', settings, restartRequired: false,
    form: { credentials: {} }, enabled: settings['enabled'] !== false, builtIn,
    description: 'Startup description', definitionAvailable: true, model: 'inherit',
    sharedAllow: ['read_file'], sharedDeny: builtIn ? [] : ['exec'],
    sharedDeniedTools: builtIn ? [] : ['exec'], missingFiles: ['SOUL.md', 'AGENTS.md', 'TOOLS.md'],
    metadata: { description: 'Startup description' },
    contextFiles: [{ path: 'IDENTITY.md', content: '---\ndescription: Startup description\n---\nStartup instructions' }],
    instructionFiles: [{ path: 'IDENTITY.md', content: 'Startup instructions' }],
  };
}

async function category(name: string) {
  const label = [...host.querySelectorAll('.settings-nav-name')].find(item => item.textContent === name);
  if (!label?.parentElement) throw new Error(`Missing Settings category: ${name}`);
  label.parentElement.click();
  await flush();
}

async function checkbox(name: string, root: ParentNode = host) {
  const input = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find(input => input.getAttribute('aria-label') === name || input.closest('label')?.textContent?.trim() === name);
  if (!input || input.disabled) throw new Error(`Missing or disabled checkbox: ${name}`);
  input.click();
  await flush();
}

async function tool(name: string, selector: string) {
  await click(selector);
  await checkbox(name, element('.tool-select-options[aria-label="' + selector + ' options"]'));
  element<HTMLButtonElement>(`button[aria-label="${selector}"]`)
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
}

async function mount(settings = initialSettings(), extraSections: Record<string, unknown>[] = []) {
  host = document.createElement('div');
  document.body.append(host);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  });
  const state = reactive({ open: false, connected: true });
  let saved = settings;
  const reply = (action: string, input: unknown = {}): SettingsActionResult => {
    const sectionId = object(input)['sectionId'] ?? 'llm';
    const extra = extraSections.find(section => section['id'] === sectionId);
    if (action === 'update') {
      if (sectionId === 'llm') saved = object(object(input)['settings']);
      else {
        if (!extra) throw new Error(`Unknown fixture section: ${sectionId}`);
        extra['settings'] = object(object(input)['settings']);
        extra['enabled'] = object(extra['settings'])['enabled'] !== false;
        if (sectionId === 'agents:defaults') {
          const tools = object(object(input)['settings'])['tools'];
          const policy = tools === undefined ? {} : object(tools);
          for (const section of extraSections.filter(section => !section['builtIn'])) {
            section['sharedAllow'] = policy['allow'] ?? [];
            section['sharedDeny'] = policy['deny'] ?? [];
            section['sharedDeniedTools'] = policy['deny'] ?? [];
          }
        }
      }
    }
    return {
      requestId: action, action, ok: true,
      output: action === 'load' ? { sections: [section(saved), ...extraSections], modelCatalog: catalog, toolCatalog, diagnostics: [] }
        : action === 'test_llm_model' ? { outcome: 'completed' }
          : { section: extra ?? section(saved), agentSections: extraSections, modelCatalog: catalog },
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
  it('separates Agents from Extensions and preserves an untouched sparse override without credentials', async () => {
    const f = await mount({}, [agentSection('general-purpose'), agentSection('reviewer'), {
      id: 'extension:test', name: 'Test Extension', revision: 'ext', restartRequired: false,
      settings: { enabled: true }, form: { credentials: {} },
    }]);
    await category('Extensions');
    expect(host.textContent).toContain('Test Extension');
    expect(host.textContent).not.toContain('Startup description');
    await category('Agents');
    expect(host.textContent).not.toContain('Test Extension');
    await click('Configure reviewer');
    expect(host.textContent).toContain('Shared deny (read-only): exec');
    await click('Save reviewer');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agent:reviewer', expectedRevision: 'reviewer-revision', settings: {},
    });
    expect(host.textContent).toContain('Applied to subsequent Turns.');
    expect(element<HTMLButtonElement>('button[aria-label="Approval bypass tools"]').disabled).toBe(true);
    await checkbox('Inherit shared approval bypass');
    await tool('edit_file', 'Additional prohibited tools');
    await checkbox('Enabled');
    await click('Save reviewer');
    expect(latestUpdate(f.execute)['settings']).toEqual({
      enabled: false, tools: { allow: [], deny: ['edit_file'] },
    });
    await checkbox('Inherit shared approval bypass');
    await tool('edit_file', 'Additional prohibited tools');
    await checkbox('Enabled');
    await click('Save reviewer');
    expect(latestUpdate(f.execute)['settings']).toEqual({});
  });

  it('renders read-only startup Context, separating frontmatter from instructions and marking missing files', async () => {
    await mount({}, [agentSection('reviewer')]);
    await category('Agents');
    await click('Configure reviewer');
    await click('Context');
    expect(host.textContent).toContain('Manual MD edits, additions and deletions require restart');
    expect(host.textContent).toContain('Frontmatter metadata (not child instructions)');
    expect(host.textContent).toContain('Body (running Context)');
    expect(host.textContent).toContain('Startup instructions');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('.settings-savebar')).toBeNull();
    await click('SOUL.md');
    expect(host.textContent).toContain('Missing SOUL.md at startup');
    expect(host.textContent).toContain('inherits the corresponding Parent file');
  });

  it('edits shared defaults without disablement and refreshes shared deny without losing another dirty draft', async () => {
    const f = await mount({}, [agentSection('general-purpose'), agentSection('reviewer')]);
    await category('Agents');
    await click('Configure reviewer');
    await tool('write_file', 'Additional prohibited tools');
    await click('Back to Agents');
    await click('Configure general-purpose');
    expect([...host.querySelectorAll('.settings-checkbox')].map(label => label.textContent?.trim()))
      .toEqual(['Use default approval rules (no bypass)']);
    expect(host.querySelector('[aria-label="Context files"]')).toBeNull();
    await tool('edit_file', 'Shared prohibited tools');
    await click('Save general-purpose');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agents:defaults', expectedRevision: 'general-purpose-revision',
      settings: { tools: { deny: ['edit_file'] } },
    });
    await click('Back to Agents');
    await click('Configure reviewer');
    expect(host.textContent).toContain('Shared deny (read-only): edit_file');
    const deny = element('.tool-select-options[aria-label="Additional prohibited tools options"]');
    expect(element<HTMLInputElement>('input[aria-label="write_file"]', deny).checked).toBe(true);
    expect(element<HTMLInputElement>('input[aria-label="edit_file"]', deny).disabled).toBe(true);
    expect(host.textContent).toContain('Unsaved');
    await click('Save reviewer');
    expect(latestUpdate(f.execute)['expectedRevision']).toBe('reviewer-revision');
    expect(latestUpdate(f.execute)['settings']).toEqual({ tools: { deny: ['write_file'] } });
  });

  it('preserves Agent drafts on revision conflicts and reports unavailable definitions and models', async () => {
    const f = await mount({}, [{
      ...agentSection('reviewer'), definitionAvailable: false,
      model: { providerId: 'absent', modelId: 'model' }, modelAvailable: false,
    }]);
    await category('Agents');
    await click('Configure reviewer');
    expect(host.textContent).toContain('No valid startup definition');
    expect(host.textContent).toContain('no silent model fallback');
    await tool('write_file', 'Additional prohibited tools');
    f.execute.mockResolvedValueOnce({
      requestId: 'conflict', action: 'update', ok: false,
      error: { code: 'revision_conflict', message: 'Reload saved Agent settings.' },
    });
    await click('Save reviewer');
    expect(element<HTMLInputElement>('.tool-select-options[aria-label="Additional prohibited tools options"] input[aria-label="write_file"]').checked).toBe(true);
    expect(element('.settings-feedback').textContent).toContain('Reload saved Agent settings.');
    expect(element<HTMLButtonElement>('.settings-savebar button')).toBeDefined();
  });

  it('preserves saved patterns and unavailable names while editing exact Tool selections', async () => {
    const saved = { tools: { allow: ['read_*', 'retired_tool', ' spaced_rule '], deny: ['write_*', 'old_deny'] } };
    const f = await mount({}, [agentSection('reviewer', saved)]);
    await category('Agents');
    await click('Configure reviewer');
    expect(host.textContent).toContain('Saved patterns or unavailable names (read-only)');
    expect([...host.querySelectorAll('.tool-select-note code')].map(item => item.textContent))
      .toEqual(['read_*', 'retired_tool', ' spaced_rule ', 'write_*', 'old_deny']);
    await tool('read_file', 'Approval bypass tools');
    await tool('edit_file', 'Additional prohibited tools');
    await click('Save reviewer');
    expect(latestUpdate(f.execute)['settings']).toEqual({
      tools: {
        allow: [...saved.tools.allow, 'read_file'],
        deny: [...saved.tools.deny, 'edit_file'],
      },
    });
    expect(latestUpdate(f.execute)).not.toHaveProperty('credentials');
  });

  it('uses top-layer Tool popovers, locks shared denies and closes only on outer scrolling or dismissal', async () => {
    const f = await mount({}, [agentSection('reviewer')]);
    await category('Agents');
    await click('Configure reviewer');
    await click('Additional prohibited tools');
    const panel = element<HTMLElement>('.tool-select-options[aria-label="Additional prohibited tools options"]');
    const trigger = element<HTMLButtonElement>('button[aria-label="Additional prohibited tools"]');
    expect(panel.getAttribute('popover')).toBe('auto');
    expect(panel.matches(':popover-open')).toBe(true);
    expect(element<HTMLInputElement>('input[aria-label="exec"]', panel)).toMatchObject({ checked: true, disabled: true });
    expect(panel.querySelectorAll('input')).toHaveLength(toolCatalog.length);
    expect(panel.textContent).toContain('Execute a command.');
    element('.tool-select-scroll', panel).dispatchEvent(new Event('scroll'));
    expect(panel.matches(':popover-open')).toBe(true);
    element('.settings-content').dispatchEvent(new Event('scroll'));
    expect(panel.matches(':popover-open')).toBe(false);
    await click('Additional prohibited tools');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(panel.matches(':popover-open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await click('Additional prohibited tools');
    window.dispatchEvent(new Event('resize'));
    expect(panel.matches(':popover-open')).toBe(false);
    await click('Additional prohibited tools');
    panel.hidePopover();
    await flush();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click('Additional prohibited tools');
    const dialog = element<HTMLDialogElement>('dialog');
    dialog.dispatchEvent(new Event('close'));
    expect(panel.matches(':popover-open')).toBe(false);
    await click('Additional prohibited tools');
    f.state.open = false;
    await flush();
    expect(panel.matches(':popover-open')).toBe(false);
  });

  it('uses themed typed selectors and preserves enum omission and checkbox-first Extension labels', async () => {
    const extension = {
      id: 'extension:test', name: 'Test Extension', revision: 'ext', restartRequired: false,
      settings: { enabled: true, config: {} },
      form: {
        credentials: {},
        fields: [
          { name: 'level', path: '/level', editable: true, supported: true, sensitive: false, schema: { type: 'number', enum: [0, 1] } },
          { name: 'approval', path: '/approval', editable: true, supported: true, sensitive: false, schema: { type: 'boolean' } },
        ],
      },
    };
    const f = await mount(initialSettings(), [extension]);
    await click('Default model');
    await click('Relay / Remote model');
    await click('Built-in details');
    await click('Edit first');
    await click('Protocol');
    await click('openai-chat-completions');
    await click('Save LLM');
    expect(latestUpdate(f.execute)['settings']).toMatchObject({
      defaultModel: { providerId: 'relay', modelId: 'remote' },
      builtin: { models: [
        { modelId: 'first', protocol: 'openai-chat-completions' },
        { modelId: 'second', protocol: 'openai-responses' },
      ] },
    });
    await category('Extensions');
    await click('Configure Test Extension');
    expect(element('.settings-checkbox').textContent).toContain('Enabled (requires service restart after saving)');
    for (const label of host.querySelectorAll('.settings-checkbox')) {
      expect(label.firstElementChild?.tagName).toBe('INPUT');
    }
    await click('level');
    await click('0');
    await checkbox('approval');
    await click('Save Test Extension');
    expect(latestUpdate(f.execute)['settings']).toEqual({ enabled: true, config: { level: 0, approval: true } });
    await click('level');
    await click('Omit / use declared default');
    await click('Save Test Extension');
    expect(latestUpdate(f.execute)['settings']).toEqual({ enabled: true, config: { approval: true } });
    expect(host.querySelector('select')).toBeNull();
  });

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
