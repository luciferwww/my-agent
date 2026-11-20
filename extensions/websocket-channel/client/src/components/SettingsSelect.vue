<script setup lang="ts" generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch, type CSSProperties } from 'vue';
import { Check, ChevronDown } from '@lucide/vue';
import { settingsDropdownPosition } from './settings-dropdown-position';

const props = withDefaults(defineProps<{
  label: string;
  description?: string;
  modelValue: T;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}>(), { disabled: false, description: '' });
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const open = ref(false);
const position = ref<CSSProperties>({});
const id = useId();
const selectedIndex = computed(() => props.options.findIndex(option =>
  Object.is(option.value, props.modelValue) || JSON.stringify(option.value) === JSON.stringify(props.modelValue)));

function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) trigger.value?.focus();
}
function optionButtons(): HTMLButtonElement[] {
  return [...panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
}
async function show(last = false) {
  const button = trigger.value;
  if (!button || button.matches(':disabled')) return;
  position.value = settingsDropdownPosition(button);
  open.value = true;
  await nextTick();
  const buttons = optionButtons();
  const selected = panel.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)');
  (last ? buttons.at(-1) : selected ?? buttons[0])?.focus();
}
function choose(index: number) {
  const option = props.options[index];
  if (option.disabled || trigger.value?.matches(':disabled')) return;
  emit('update:modelValue', option.value);
  close(true);
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    if (!open.value) {
      void show(event.key === 'ArrowUp' || event.key === 'End');
      return;
    }
    const buttons = optionButtons();
    const current = buttons.findIndex(button => button === document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  } else if (event.key === 'Tab' && open.value) {
    close(true);
  }
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close();
}
function scroll(event: Event) {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return;
  close();
}
function resize() { close(); }
watch(() => props.disabled, disabled => { if (disabled) close(); });
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', resize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('scroll', scroll, true);
  window.removeEventListener('resize', resize);
});
</script>

<template>
  <div ref="root" class="model-picker settings-select" :class="{ open }" @keydown="keydown">
    <span class="field-label-text">{{ label }}</span>
    <span v-if="description" class="settings-select-description">{{ description }}</span>
    <button ref="trigger" class="model-picker-trigger" type="button" :disabled="disabled"
      :aria-label="label" :aria-expanded="open" :aria-controls="id" aria-haspopup="listbox"
      @click="open ? close() : show()">
      <span class="model-picker-trigger-copy">
        <span class="model-picker-trigger-name">{{ options[selectedIndex]?.label ?? 'Select an option' }}</span>
      </span>
      <ChevronDown class="model-picker-chevron" aria-hidden="true" />
    </button>
    <div v-if="open" :id="id" ref="panel" class="model-picker-panel settings-select-panel"
      role="listbox" :aria-label="`${label} options`" :style="position">
      <div class="settings-select-scroll">
        <button v-for="(option, index) in options" :key="index" class="model-picker-option"
          :class="{ selected: selectedIndex === index }" type="button" role="option" tabindex="-1"
          :aria-selected="selectedIndex === index" :disabled="option.disabled" @click="choose(index)">
          <span class="model-picker-check" aria-hidden="true"><Check v-if="selectedIndex === index" /></span>
          <span class="model-picker-option-copy"><span class="model-picker-option-name">{{ option.label }}</span></span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-select { min-width: 0; }
.settings-select-description { display: block; margin-bottom: 6px; color: var(--muted); font-size: 12px; }
.settings-select-panel { position: fixed; z-index: 40; display: flex; flex-direction: column; overflow: hidden; }
.settings-select-scroll { min-height: 0; overflow: auto; }
.settings-select-panel .model-picker-option-name { white-space: normal; overflow-wrap: anywhere; }
.model-picker-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
