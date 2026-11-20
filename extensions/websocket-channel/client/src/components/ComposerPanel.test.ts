// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, ref, type App } from 'vue';
import ApprovalPanel from './ApprovalPanel.vue';
import ComposerPanel from './ComposerPanel.vue';
import ModelReasoningPicker from './ModelReasoningPicker.vue';

let app: App | undefined;
let host: HTMLDivElement;

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  vi.restoreAllMocks();
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  const state = reactive({
    draft: 'Keep this draft',
    pendingApprovalCount: 0,
    disabled: false,
    connected: true,
    showThinking: true,
    showEffort: true,
    reasoning: { thinking: 'default', effort: 'none' } as Record<string, string>,
  });
  const modelSelected = vi.fn();
  const reasoningSelected = vi.fn((kind: string, value: string) => { state.reasoning[kind] = value; });
  const opening = vi.fn();
  const abort = vi.fn();
  const resolved = vi.fn();
  const modelPicker = ref<{ closeTransientUi(): void }>();
  const providers = [
    { providerId: 'a', displayName: 'Provider A', models: [
      { modelId: 'fast', displayName: 'Fast model' },
      { modelId: 'deep', displayName: 'Deep model' },
    ] },
    { providerId: 'b', displayName: 'Provider B', models: [{ modelId: 'vision', displayName: 'Vision model' }] },
  ];
  app = createApp({
    setup: () => () => h(ComposerPanel, {
      modelValue: state.draft,
      attachments: [],
      attachError: '',
      selectedModelSupportsImages: true,
      attachmentCapabilityExplanation: '',
      isWaitingForReply: false,
      maxAttachmentsPerMessage: 4,
      isConnected: state.connected,
      canSend: true,
      pendingApprovalCount: state.pendingApprovalCount,
      onAbort: abort,
    }, {
      controls: () => h(ModelReasoningPicker, {
        ref: modelPicker,
        availableModels: providers.flatMap(provider => provider.models),
        availableModelProviders: providers,
        modelPickerLabel: 'Fast model',
        selectedModelDetails: { reference: { providerId: 'a', modelId: 'fast' }, provider: providers[0] },
        modelControlsDisabled: state.disabled,
        showThinkingControl: state.showThinking,
        showEffortControl: state.showEffort,
        reasoningSelection: state.reasoning,
        reasoningConstraintNotice: '',
        isConnected: state.connected,
        formatReasoningOption: (value: string) => value,
        reasoningPickerOptions: (kind: string) => kind === 'thinking' ? ['default', 'on', 'off'] : ['default', 'none', 'low'],
        isReasoningPickerOptionDisabled: (kind: string, value: string) => kind === 'thinking' && value === 'on' && state.reasoning.effort === 'none',
        modelOptionToken: (providerId: string, modelId: string) => `${providerId}:${modelId}`,
        isSelectedModel: (providerId: string, modelId: string) => providerId === 'a' && modelId === 'fast',
        isRuntimeDefaultModel: (providerId: string, modelId: string) => providerId === 'a' && modelId === 'fast',
        onModelPickerOpening: opening,
        onSelectModel: modelSelected,
        onSelectReasoningOption: reasoningSelected,
      }),
      default: () => h(ApprovalPanel, {
        sessionId: 'session',
        approvals: [{ id: 'approval', sessionId: 'session', turnId: 'turn', callId: 'call', toolName: 'write_file', input: {} }],
        sources: { approval: 'Current session' },
        isConnected: state.connected,
        onAbort: abort,
        onResolveApproval: resolved,
      }),
    }),
  });
  app.mount(host);
  await nextTick();
  return { state, modelPicker, modelSelected, reasoningSelected, opening, abort, resolved };
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

async function click(selector: string) {
  element<HTMLButtonElement>(selector).click();
  await nextTick();
}

async function key(target: HTMLElement, value: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  await nextTick();
}

describe('Composer model controls', () => {
  it('places selectors before right-side actions and puts the existing instructions in the placeholder only', async () => {
    await mount();
    const row = element('.composer-row');
    expect(row.firstElementChild?.classList.contains('composer-model-controls')).toBe(true);
    expect(row.lastElementChild?.classList.contains('composer-actions')).toBe(true);
    expect(element<HTMLTextAreaElement>('textarea').placeholder).toBe(
      'Send a message to the agent… \nPress Enter to send or Shift+Enter for a new line. Attach up to 4 images (10 MB total) by button, drop, or paste.',
    );
    expect(host.querySelector('.composer-hint')).toBeNull();
    expect([...element('.composer-actions').querySelectorAll('button')].map(button => button.textContent?.trim()))
      .toEqual(['Images', 'Reset', 'Send']);
  });

  it('preserves catalog opening, provider/model search, keyboard selection and focus restoration', async () => {
    const { modelSelected, opening } = await mount();
    const trigger = element<HTMLButtonElement>('.composer-model-picker button');
    await click('.composer-model-picker button');
    expect(opening).toHaveBeenCalledOnce();
    const search = element<HTMLInputElement>('.model-picker-search');
    expect(document.activeElement).toBe(search);
    expect(document.querySelectorAll('.composer-picker-panel [role="option"]')).toHaveLength(3);
    expect(element('.model-picker-default-badge').textContent).toBe('Default');
    search.value = 'PROVIDER B';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(document.querySelectorAll('.composer-picker-panel [role="option"]')).toHaveLength(1);
    await key(search, 'ArrowDown');
    expect(search.getAttribute('aria-activedescendant')).toBe(element('[role="option"]').id);
    await key(search, 'Enter');
    expect(modelSelected).toHaveBeenCalledWith('b', 'vision');
    expect(document.querySelector('.composer-picker-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await click('.composer-model-picker button');
    const secondSearch = element<HTMLInputElement>('.model-picker-search');
    secondSearch.value = 'deep';
    secondSearch.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(element('[role="option"]').textContent).toContain('Deep model');
    await key(secondSearch, 'Escape');
    expect(document.activeElement).toBe(trigger);
    expect(modelSelected).toHaveBeenCalledOnce();
  });

  it('honors capability visibility/constraints and closes popups when controls become disabled', async () => {
    const { state, reasoningSelected } = await mount();
    await click('[aria-label="Thinking: default"]');
    expect(element<HTMLButtonElement>('.composer-picker-panel button:nth-child(2)').disabled).toBe(true);
    await key(element<HTMLButtonElement>('.composer-picker-panel [aria-selected="true"]'), 'ArrowDown');
    expect(document.activeElement?.textContent).toContain('off');
    (document.activeElement as HTMLButtonElement).click();
    await nextTick();
    expect(reasoningSelected).toHaveBeenCalledWith('thinking', 'off');
    expect(element('[aria-label="Thinking: off"]')).toBe(document.activeElement);
    state.showEffort = false;
    await nextTick();
    expect(host.querySelector('[aria-label^="Reasoning effort:"]')).toBeNull();
    await click('.composer-model-picker button');
    state.disabled = true;
    await nextTick();
    expect(document.querySelector('.composer-picker-panel')).toBeNull();
    expect([...element('.composer-model-controls').querySelectorAll('button')].every(button => button.disabled)).toBe(true);
  });

  it('keeps the popup above the composer and inside mobile viewport edges on resize/scroll', async () => {
    await mount();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(360);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700);
    const trigger = element<HTMLButtonElement>('.composer-model-picker button');
    const rect = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 620, 180, 40));
    await click('.composer-model-picker button');
    const panel = element('.composer-picker-panel');
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.width).toBe('320px');
    expect(panel.style.left).toBe('32px');
    expect(panel.style.bottom).toBe('86px');
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(280);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(panel.style.width).toBe('264px');
    expect(panel.style.left).toBe('8px');
    rect.mockReturnValue(new DOMRect(20, 200, 180, 40));
    host.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(panel.style.top).toBe('246px');
    expect(panel.style.bottom).toBe('auto');
  });

  it('fully replaces the composer and any open popup with the existing approval card/actions', async () => {
    const { state, abort, resolved } = await mount();
    await click('.composer-model-picker button');
    state.pendingApprovalCount = 1;
    await nextTick();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('.composer-model-controls')).toBeNull();
    expect(host.querySelector('.composer-actions')).toBeNull();
    expect(document.querySelector('.composer-picker-panel')).toBeNull();
    expect(element('.approval-deck').getAttribute('aria-label')).toBe('Pending approvals');
    const actions = [...element('.approval-actions').querySelectorAll('button')];
    expect(actions.map(button => button.textContent?.trim())).toEqual(['Stop', 'Deny', 'Allow']);
    actions[0].click();
    actions[1].click();
    expect(abort).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith('approval', 'deny');
    state.pendingApprovalCount = 0;
    await nextTick();
    expect(element<HTMLTextAreaElement>('textarea').value).toBe('Keep this draft');
    expect(host.querySelector('.composer-model-controls')).not.toBeNull();
  });

  it('closes the picker directly for navigation changes and on disconnect', async () => {
    const { state, modelPicker } = await mount();
    await click('.composer-model-picker button');
    modelPicker.value?.closeTransientUi();
    await nextTick();
    expect(document.querySelector('.composer-picker-panel')).toBeNull();
    await click('[aria-label="Thinking: default"]');
    state.connected = false;
    await nextTick();
    expect(document.querySelector('.composer-picker-panel')).toBeNull();
    expect([...element('.composer-model-controls').querySelectorAll('button')].every(button => button.disabled)).toBe(true);
  });
});
