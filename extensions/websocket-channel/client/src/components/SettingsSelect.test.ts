// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import SettingsSelect from './SettingsSelect.vue';
import { settingsDropdownPosition } from './settings-dropdown-position';

let app: App | undefined;
let host: HTMLDivElement;

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  vi.restoreAllMocks();
});

async function mount(value: unknown = 'first') {
  host = document.createElement('div');
  document.body.append(host);
  const changed = vi.fn();
  const state = reactive({
    value,
    disabled: false,
    fieldsetDisabled: false,
    options: [
      { value: 'first', label: 'First' },
      { value: 'blocked', label: 'Blocked', disabled: true },
      { value: 'last', label: 'Last' },
    ] as { value: unknown; label: string; disabled?: boolean }[],
  });
  app = createApp({
    setup: () => () => h('fieldset', { disabled: state.fieldsetDisabled }, [
      h(SettingsSelect, {
        label: 'Choice', modelValue: state.value, options: state.options, disabled: state.disabled,
        'onUpdate:modelValue': (value: unknown) => { state.value = value; changed(value); },
      }),
    ]),
  });
  app.mount(host);
  await nextTick();
  const trigger = element<HTMLButtonElement>('button[aria-label="Choice"]');
  return { state, changed, trigger };
}

function element<T extends Element = HTMLElement>(selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error(`Missing selector element: ${selector}`);
  return found;
}

async function key(target: HTMLElement, value: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  await nextTick();
}

describe('SettingsSelect', () => {
  it('supports keyboard navigation, skips disabled options and restores focus on Escape', async () => {
    const { trigger, changed } = await mount('last');
    await key(trigger, 'ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toContain('Last');
    await key(element('button[aria-selected="true"]'), 'ArrowUp');
    expect(document.activeElement?.textContent).toContain('First');
    await key(element('.settings-select-panel'), 'End');
    expect(document.activeElement?.textContent).toContain('Last');
    await key(element('.settings-select-panel'), 'Home');
    expect(document.activeElement?.textContent).toContain('First');
    await key(element('.settings-select-panel'), 'Escape');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([undefined, false, 0, { mode: 'custom' }])('preserves typed option value %j', async value => {
    const { state, trigger, changed } = await mount();
    state.options = [{ value, label: 'Typed choice' }];
    await nextTick();
    trigger.click();
    await nextTick();
    element<HTMLButtonElement>('[role="option"]').click();
    await nextTick();
    expect(changed).toHaveBeenCalledWith(value);
    expect(state.value).toEqual(value);
    expect(trigger.textContent).toContain('Typed choice');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes on outside pointer, outer scroll, resize or Tab but not internal scrolling', async () => {
    const { trigger } = await mount();
    const open = async () => { trigger.click(); await nextTick(); };
    await open();
    element('.settings-select-scroll').dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await open();
    host.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await open();
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await open();
    await key(element('.settings-select-panel'), 'Tab');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('honors direct and inherited fieldset disablement and closes when disabled', async () => {
    const { state, trigger } = await mount();
    const matches = trigger.matches.bind(trigger);
    // happy-dom does not implement :disabled inherited from a fieldset.
    vi.spyOn(trigger, 'matches').mockImplementation(selector =>
      selector === ':disabled' ? trigger.disabled || state.fieldsetDisabled : matches(selector));
    state.fieldsetDisabled = true;
    await nextTick();
    await key(trigger, 'ArrowDown');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    state.fieldsetDisabled = false;
    await nextTick();
    trigger.click();
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    state.disabled = true;
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger.disabled).toBe(true);
  });

  it('removes its global listeners when unmounted', async () => {
    await mount();
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    app?.unmount();
    app = undefined;
    expect(removeDocument).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});

describe('Settings dropdown positioning', () => {
  function triggerAt(x: number, y: number, width: number, height: number) {
    const trigger = document.createElement('button');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height));
    return trigger;
  }

  it('floats below with a bounded height when space is available', () => {
    expect(settingsDropdownPosition(triggerAt(100, 100, 250, 40))).toEqual({
      left: '100px', width: '250px', maxHeight: '280px', top: '146px',
    });
  });

  it('floats above near the viewport bottom', () => {
    expect(settingsDropdownPosition(triggerAt(100, window.innerHeight - 60, 250, 40))).toEqual({
      left: '100px', width: '250px', maxHeight: '280px', bottom: '66px', top: 'auto',
    });
  });

  it('constrains wide triggers and offscreen edges to viewport margins', () => {
    expect(settingsDropdownPosition(triggerAt(-20, 100, window.innerWidth + 100, 40))).toMatchObject({
      left: '8px', width: `${window.innerWidth - 16}px`,
    });
    expect(settingsDropdownPosition(triggerAt(window.innerWidth - 100, 100, 250, 40))).toMatchObject({
      left: `${window.innerWidth - 258}px`,
    });
  });
});
