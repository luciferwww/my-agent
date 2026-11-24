// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import type { SettingsActionResult } from 'my-agent/extension-api';
import { object } from '../client/settings';
import SettingsPanel from './SettingsPanel.vue';
import type { ThemeId } from '../client/theme';

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
  vi.useRealTimers();
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
const skillCatalog = { entries: [
  { name: 'review', description: 'Review changes.', relativeDirectory: 'builtin/review' },
], diagnostics: [] };

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
    id: builtIn ? 'agents:defaults' : `agent:${id}`, name: builtIn ? 'Default Tool permissions' : id, revision: `${id}-revision`,
    kind: builtIn ? 'agent-defaults' : 'agent', settings, restartRequired: false,
    form: { credentials: {} }, enabled: settings['enabled'] !== false, builtIn,
    description: 'Startup description', definitionAvailable: true, model: 'inherit',
    sharedAllow: ['read_file'], sharedDeny: builtIn ? [] : ['exec'],
    sharedDeniedTools: builtIn ? [] : ['exec'], missingFiles: ['SOUL.md', 'AGENTS.md', 'TOOLS.md'],
    metadata: { description: 'Startup description' },
    contextFiles: [{ path: 'IDENTITY.md', content: '---\ndescription: Startup description\n---\nStartup instructions' }],
    instructionFiles: [{ path: 'IDENTITY.md', content: 'Startup instructions' }],
    ...(builtIn ? {} : { sharedSkills: ['review'], effectiveSkills: settings['skills'] ?? ['review'] }),
  };
}

function executionSection(settings: Record<string, unknown> = {}) {
  const defaults = { steeringEnabled: true, maxSubagentDepth: 1 };
  return {
    id: 'agents:execution', kind: 'agent-execution', name: 'Execution policy',
    revision: 'execution-revision', settings, form: { credentials: {} },
    defaults, resolvedSettings: { ...defaults, ...settings },
    restartRequired: false,
  };
}

function sandboxSection() {
  const settings = { enabled: false, network: 'none', read: [], write: [], deny: [] };
  return {
    id: 'agents:sandbox', kind: 'sandbox', name: 'Execution Sandbox', revision: 'sandbox-revision',
    settings, appliedSettings: settings, platform: 'linux', restartRequired: false,
    applicationStatus: 'current', form: { credentials: {} },
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

async function mount(
  settings = initialSettings(),
  extraSections: Record<string, unknown>[] = [],
  skillCatalogError?: { code: string; message: string },
) {
  host = document.createElement('div');
  document.body.append(host);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  });
  const state = reactive<{ open: boolean; connected: boolean; theme: ThemeId }>({
    open: false, connected: true, theme: 'classic',
  });
  const themeSelected = vi.fn((theme: ThemeId) => { state.theme = theme; });
  let saved = settings;
  const reply = (action: string, input: unknown = {}): SettingsActionResult => {
    if (action === 'skills_catalog' && skillCatalogError) {
      return { requestId: action, action, ok: false, error: skillCatalogError };
    }
    const sectionId = object(input)['sectionId'] ?? 'llm';
    const extra = extraSections.find(section => section['id'] === sectionId);
    if (action === 'update') {
      if (sectionId === 'llm') saved = object(object(input)['settings']);
      else {
        if (!extra) throw new Error(`Unknown fixture section: ${sectionId}`);
        extra['settings'] = object(object(input)['settings']);
        extra['enabled'] = object(extra['settings'])['enabled'] !== false;
        if (sectionId === 'agents:execution') {
          extra['resolvedSettings'] = { ...object(extra['defaults']), ...object(extra['settings']) };
          extra['restartRequired'] = false;
          extra['applicationStatus'] = 'current';
        }
        if (sectionId === 'agents:sandbox') {
          extra['restartRequired'] = JSON.stringify(extra['settings']) !== JSON.stringify(extra['appliedSettings']);
          extra['applicationStatus'] = extra['restartRequired'] ? 'restart_required' : 'current';
        }
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
      output: action === 'skills_catalog' ? skillCatalog
        : action === 'load' ? {
          sections: [section(saved), ...extraSections], modelCatalog: catalog, toolCatalog, diagnostics: [],
          ...(skillCatalogError ? { skillCatalogError } : { skillCatalog }),
        }
        : action === 'test_llm_model' ? { outcome: 'completed' }
          : { section: extra ?? section(saved), agentSections: extraSections.filter(item => item['kind'] !== 'agent-execution'), modelCatalog: catalog },
    };
  };
  const execute = vi.fn<(action: string, input: unknown) => Promise<SettingsActionResult>>(
    async (action, input) => reply(action, input),
  );
  app = createApp({ setup: () => () => h(SettingsPanel, {
    open: state.open, connected: state.connected, theme: state.theme, execute, onSelectTheme: themeSelected,
  }) });
  app.mount(host);
  state.open = true;
  await flush();
  return { execute, state, reply, themeSelected };
}

describe('General client preferences', () => {
  it('changes Theme immediately without a service save, including while disconnected', async () => {
    const { execute, state, themeSelected } = await mount();
    await category('General');
    expect(host.querySelector('.settings-savebar')).toBeNull();
    const callsBeforeThemeChange = execute.mock.calls.length;
    await click('Theme');
    await click('Botanical');
    expect(themeSelected).toHaveBeenLastCalledWith('botanical');
    expect(element('[aria-label="Theme"]').textContent).toContain('Botanical');
    expect(execute).toHaveBeenCalledTimes(callsBeforeThemeChange);

    await click('Reload saved settings');
    expect(element('h3').textContent).toBe('General');
    expect(element('[aria-label="Theme"]').textContent).toContain('Botanical');

    state.connected = false;
    await flush();
    const callsBeforeOfflineChange = execute.mock.calls.length;
    await click('Theme');
    await click('Classic');
    expect(themeSelected).toHaveBeenLastCalledWith('classic');
    expect(element('[aria-label="Theme"]').textContent).toContain('Classic');
    expect(execute).toHaveBeenCalledTimes(callsBeforeOfflineChange);
  });
});

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
  it('edits Sandbox under global settings, warns without blocking, and preserves startup state until restart', async () => {
    const f = await mount(initialSettings(), [sandboxSection()]);
    await category('Agents');
    await click('Global settings');
    await click('Configure Execution Sandbox');
    expect(host.textContent).toContain('Sandbox disabled (host-direct Exec)');
    await checkbox('Enable Sandbox');
    await click('Network access');
    await click('Outbound and host loopback');
    expect(host.textContent).toContain('may trust localhost');
    expect(host.textContent).toContain('Linux MXC 1.1.0 does not support');
    await fill('Read paths', '/reference\n/other reference');
    await fill('Write paths', '/work');
    await fill('Deny paths', '/work/private');
    await click('Back to Global settings');
    expect(host.textContent).toContain('Unsaved');
    await click('Configure Execution Sandbox');
    await click('Save Execution Sandbox');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agents:sandbox', expectedRevision: 'sandbox-revision',
      settings: {
        enabled: true, network: 'outbound-and-loopback', read: ['/reference', '/other reference'],
        write: ['/work'], deny: ['/work/private'],
      },
    });
    expect(host.textContent).toContain('Sandbox disabled (host-direct Exec)');
    expect(host.textContent).toContain('Saved, not applied: restart required.');
    await checkbox('Enable Sandbox');
    await click('Network access');
    await click('No external network');
    await fill('Read paths', '');
    await fill('Write paths', '');
    await fill('Deny paths', '');
    await click('Save Execution Sandbox');
    expect(host.textContent).not.toContain('Restart required');
    expect(host.textContent).not.toContain('Unsaved');
  });

  it('edits Memory through Global settings with the shared checkbox, restart badge, and enabled-only save', async () => {
    const memory = {
      id: 'agents:memory', kind: 'memory', name: 'Memory', revision: 'memory-revision',
      settings: { enabled: true }, restartRequired: false, form: { credentials: {} },
    };
    const f = await mount(initialSettings(), [executionSection(), memory]);
    await category('Agents');
    await click('Global settings');
    await click('Configure Memory');
    expect(host.textContent).toContain('HF_ENDPOINT');
    expect(host.textContent).toContain('Saved changes require a service restart.');
    await checkbox('Enable Memory');
    await click('Back to Global settings');
    expect(host.textContent).toContain('Unsaved');
    await click('Configure Memory');
    const response = deferredResult();
    f.execute.mockImplementationOnce(() => response.promise);
    const saving = click('Save Memory');
    await nextTick();
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agents:memory', expectedRevision: 'memory-revision', settings: { enabled: false },
    });
    response.resolve({
      requestId: 'update', action: 'update', ok: true,
      output: { section: { ...memory, settings: { enabled: false }, restartRequired: true } },
    });
    await saving;
    expect(host.textContent).toContain('Restart required');
    await click('Back to Global settings');
    expect(host.textContent).toContain('Restart required');
    expect(host.textContent).not.toContain('Unsaved');
  });

  it('loads and saves other settings during a Skill catalog failure and displays the specific error', async () => {
    const f = await mount(initialSettings(), [agentSection('reviewer', { skills: ['review'] })], {
      code: 'skills_catalog_failed', message: 'Skills root must be a regular directory, not a link.',
    });
    expect(host.textContent).toContain('Settings loaded.');
    await click('Built-in details');
    await fill('Base URL', 'https://updated.example.invalid/v1');
    await click('Save LLM');
    expect(object(object(latestUpdate(f.execute)['settings'])['builtin'])['baseURL'])
      .toBe('https://updated.example.invalid/v1');
    await category('Agents');
    await click('Agent list');
    await click('Configure reviewer');
    expect(host.textContent).toContain('Skills root must be a regular directory, not a link.');
    expect(host.textContent).toContain('review (unavailable)');
    expect(element<HTMLInputElement>('.skill-options input').checked).toBe(true);
    f.execute.mockImplementation(async (action, input) => action === 'skills_catalog'
      ? { requestId: action, action, ok: true, output: skillCatalog } : f.reply(action, input));
    f.state.connected = false;
    await nextTick();
    f.state.connected = true;
    await flush();
    expect(host.textContent).not.toContain('Skills root must be a regular directory, not a link.');
    expect(host.textContent).toContain('Review changes.');
    expect(element<HTMLInputElement>('.skill-options input').checked).toBe(true);
  });

  it('saves default and explicit-empty named Skills without losing Tools or sending credentials', async () => {
    const defaults = {
      id: 'agents:skills', kind: 'agent-skills', name: 'Default Skills', revision: 'skills-revision',
      restartRequired: false, settings: {}, effectiveSkills: [], form: { credentials: {} },
    };
    const f = await mount({}, [defaults, agentSection('reviewer', { tools: { deny: ['exec'] } })]);
    await category('Agents');
    await click('Global settings');
    await click('Configure Default Skills');
    await checkbox('Use default (no Skills)');
    const option = element<HTMLInputElement>('.skill-options input');
    expect(option.checked).toBe(false);
    option.click();
    await flush();
    await click('Save Default Skills');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agents:skills', expectedRevision: 'skills-revision', settings: { skills: ['review'] },
    });
    await click('Back to Global settings');
    await click('Back to Agents');
    await click('Agent list');
    await click('Configure reviewer');
    await checkbox('Inherit default Skills');
    expect(host.textContent).toContain('Custom empty selection');
    await click('Save reviewer');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agent:reviewer', expectedRevision: 'reviewer-revision',
      settings: { tools: { deny: ['exec'] }, skills: [] },
    });
    await checkbox('Inherit default Skills');
    await click('Save reviewer');
    expect(object(latestUpdate(f.execute)['settings'])).not.toHaveProperty('skills');
  });

  it('polls catalogs without resetting drafts or revisions, and stops on close/disconnect/disposal', async () => {
    const f = await mount({}, [agentSection('reviewer', { skills: ['missing'], tools: { deny: ['exec'] } })]);
    await category('Agents');
    await click('Agent list');
    await click('Configure reviewer');
    expect(host.textContent).toContain('missing (unavailable)');
    await checkbox('Enabled');
    const catalogCalls = () => f.execute.mock.calls.filter(([action]) => action === 'skills_catalog').length;
    vi.useFakeTimers();
    f.state.connected = false;
    await nextTick();
    const previous = catalogCalls();
    await vi.advanceTimersByTimeAsync(4000);
    expect(catalogCalls()).toBe(previous);
    f.execute.mockImplementation(async (action, input) => action === 'skills_catalog' ? {
      requestId: action, action, ok: true, output: {
        entries: [...skillCatalog.entries, { name: 'new', description: 'New Skill', relativeDirectory: 'new' }],
        diagnostics: [],
      },
    } : f.reply(action, input));
    f.state.connected = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.textContent).toContain('New Skill');
    expect(element<HTMLInputElement>('.settings-checkbox input').checked).toBe(false);
    expect(host.textContent).toContain('missing (unavailable)');
    expect([...host.querySelectorAll<HTMLInputElement>('.skill-options input')].filter(input => input.checked)).toHaveLength(1);
    expect(host.textContent).toContain('Unsaved');
    const count = catalogCalls();
    await vi.advanceTimersByTimeAsync(1999);
    expect(catalogCalls()).toBe(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(catalogCalls()).toBe(count + 1);
    f.state.open = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(4000);
    expect(catalogCalls()).toBe(count + 1);
    app?.unmount();
    app = undefined;
    await vi.advanceTimersByTimeAsync(4000);
    expect(catalogCalls()).toBe(count + 1);
  });

  it('groups globals and Agents, and exposes only one shared permission editor', async () => {
    const f = await mount({}, [executionSection(), agentSection('general-purpose', {
      tools: { allow: ['read_file'], deny: ['exec'] },
    }), agentSection('reviewer')]);
    await category('Agents');
    expect(host.querySelector('[aria-label="Configure reviewer"]')).toBeNull();
    await click('Agent list');
    await click('View general-purpose');
    expect(host.textContent).toContain('Shared approval bypass (read-only): read_file');
    expect(host.textContent).toContain('Shared deny (read-only): exec');
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('.settings-savebar')).toBeNull();
    await click('Edit default Tool permissions');
    expect(host.textContent).toContain('Default Tool permissions');
    expect(host.querySelector('[aria-label="Approval bypass tools"]')).not.toBeNull();
    await click('Back to Global settings');
    await click('Configure Execution policy');
    await click('Save Execution policy');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agents:execution', expectedRevision: 'execution-revision', settings: {},
    });
    expect(element('[role="status"]').textContent).toBe('Execution policy: saved.');
    expect(host.textContent).not.toContain('Current running policy');
  });

  it('validates call limits, preserves execution drafts across navigation and resets fields sparsely', async () => {
    const f = await mount({}, [executionSection(), agentSection('general-purpose')]);
    await category('Agents');
    await click('Global settings');
    await click('Configure Execution policy');
    await checkbox('Enable steering');
    await fill('Maximum Subagent depth', '0');
    await checkbox('Limit Model calls per Turn');
    await click('Save Execution policy');
    expect(f.execute.mock.calls.filter(([action]) => action === 'update')).toHaveLength(0);
    expect(host.textContent).toContain('requires an integer');
    await fill('Maximum Model calls per Turn', '3');
    await click('Back to Global settings');
    await click('Configure Default Tool permissions');
    await click('Save Default Tool permissions');
    expect(latestUpdate(f.execute)['sectionId']).toBe('agents:defaults');
    await click('Back to Global settings');
    await click('Configure Execution policy');
    expect(host.textContent).toContain('Unsaved');
    await click('Save Execution policy');
    expect(latestUpdate(f.execute)['settings']).toEqual({
      steeringEnabled: false, maxSubagentDepth: 0, maxLlmCallsPerTurn: 3,
    });
    expect(element('[role="status"]').textContent).toBe('Execution policy: saved.');
    expect(host.textContent).not.toContain('Current running policy');
    expect(host.textContent).not.toContain('Restart required');
    expect(host.textContent).not.toContain('subsequent Turns');
    for (const field of ['steeringEnabled', 'maxSubagentDepth', 'maxLlmCallsPerTurn']) await click(`Reset ${field}`);
    await click('Save Execution policy');
    expect(latestUpdate(f.execute)['settings']).toEqual({});
    expect(element('[role="status"]').textContent).toBe('Execution policy: saved.');
    expect(host.textContent).not.toContain('Saved, not applied: restart required.');
  });

  it.each(['revision_conflict', 'request_timeout', 'malformed'])(
    'retains the execution draft and requires reload after an unconfirmed %s save',
    async reason => {
      const f = await mount({}, [executionSection()]);
      await category('Agents');
      await click('Global settings');
      await click('Configure Execution policy');
      await checkbox('Enable steering');
      f.execute.mockImplementationOnce(async () => reason === 'malformed'
        ? { requestId: 'update', action: 'update', ok: true, output: {
          section: { ...executionSection(), resolvedSettings: undefined },
        } }
        : { requestId: 'update', action: 'update', ok: false, error: {
          code: reason, message: 'Reload before saving again.',
        } });
      await click('Save Execution policy');
      expect(element<HTMLInputElement>('input[type="checkbox"]').checked).toBe(false);
      expect(host.textContent).toContain('Unsaved');
      expect(host.textContent).toContain('Reload');
      expect(element<HTMLButtonElement>('.settings-savebar button').disabled).toBe(true);
    },
  );

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
    await click('Agent list');
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
    await click('Agent list');
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
    await click('Agent list');
    await click('Configure reviewer');
    await tool('write_file', 'Additional prohibited tools');
    await click('Back to Agent list');
    await click('Back to Agents');
    await click('Global settings');
    await click('Configure Default Tool permissions');
    expect([...host.querySelectorAll('.settings-checkbox')].map(label => label.textContent?.trim()))
      .toEqual(['Use default approval rules (no bypass)']);
    expect(host.querySelector('[aria-label="Context files"]')).toBeNull();
    await tool('edit_file', 'Shared prohibited tools');
    await click('Save Default Tool permissions');
    expect(latestUpdate(f.execute)).toEqual({
      sectionId: 'agents:defaults', expectedRevision: 'general-purpose-revision',
      settings: { tools: { deny: ['edit_file'] } },
    });
    await click('Back to Global settings');
    await click('Back to Agents');
    await click('Agent list');
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
    await click('Agent list');
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
    await click('Agent list');
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
    await click('Agent list');
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
