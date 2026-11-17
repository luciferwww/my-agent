<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch, type CSSProperties } from 'vue';
import type { SettingsTool } from '../client/settings';
import { settingsDropdownPosition } from './settings-dropdown-position';

const props = withDefaults(defineProps<{
  label: string;
  modelValue: string;
  tools: SettingsTool[];
  disabled?: boolean;
  lockedTools?: string[];
}>(), { disabled: false, lockedTools: () => [] });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const open = ref(false);
const position = ref<CSSProperties>({});
const id = useId();
const values = computed(() => props.modelValue.split(/\r?\n/u).filter(Boolean));
const selectedCount = computed(() => props.tools.filter(tool =>
  values.value.includes(tool.name) || props.lockedTools.includes(tool.name)).length);
const savedRules = computed(() => values.value.filter(value =>
  /[*?]/u.test(value) || !props.tools.some(tool => tool.name === value)));

function toggle(name: string) {
  const next = values.value.includes(name)
    ? values.value.filter(value => value !== name) : [...values.value, name];
  emit('update:modelValue', next.join('\n'));
}
function close() {
  open.value = false;
  if (panel.value?.matches(':popover-open')) panel.value.hidePopover();
}
async function toggleOpen() {
  if (open.value) { close(); return; }
  if (!trigger.value || trigger.value.matches(':disabled')) return;
  position.value = settingsDropdownPosition(trigger.value);
  open.value = true;
  await nextTick();
  if (open.value) panel.value?.showPopover();
}
function syncOpen() {
  open.value = panel.value?.matches(':popover-open') ?? false;
}
function scroll(event: Event) {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return;
  close();
}
function dialogClosed(event: Event) {
  if (event.target instanceof HTMLDialogElement && event.target.contains(panel.value ?? null)) close();
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return;
  event.preventDefault();
  event.stopPropagation();
  close();
  trigger.value?.focus();
}
watch(() => props.disabled, disabled => { if (disabled) close(); });
onMounted(() => {
  document.addEventListener('scroll', scroll, true);
  document.addEventListener('close', dialogClosed, true);
  window.addEventListener('resize', close);
});
onBeforeUnmount(() => {
  close();
  document.removeEventListener('scroll', scroll, true);
  document.removeEventListener('close', dialogClosed, true);
  window.removeEventListener('resize', close);
});
</script>

<template>
  <div class="tool-select" @keydown="escape">
    <span class="tool-select-label">{{ label }}</span>
    <button ref="trigger" type="button" class="tool-select-trigger" :aria-label="label"
      :aria-expanded="open" :aria-controls="id" :disabled="disabled" @click="toggleOpen">
      <span>{{ selectedCount }} selected<span v-if="savedRules.length"> + {{ savedRules.length }} saved rule{{ savedRules.length === 1 ? '' : 's' }}</span></span>
      <span aria-hidden="true">{{ open ? '-' : '+' }}</span>
    </button>
    <div :id="id" ref="panel" popover="auto" class="tool-select-options" role="group"
      :aria-label="`${label} options`" :style="position" @toggle="syncOpen">
      <div class="tool-select-scroll">
        <p v-if="!tools.length" class="tool-select-note">No registered Tools.</p>
        <label v-for="tool in tools" :key="tool.name" class="tool-select-option">
          <input type="checkbox" :aria-label="tool.name"
            :checked="values.includes(tool.name) || lockedTools.includes(tool.name)"
            :disabled="disabled || lockedTools.includes(tool.name)" @change="toggle(tool.name)">
          <span class="tool-select-copy">
            <strong>{{ tool.name }}<span v-if="lockedTools.includes(tool.name)" class="tool-select-note"> (shared, read-only)</span></strong>
            <span class="tool-select-description" :title="tool.description">{{ tool.description }}</span>
          </span>
        </label>
      </div>
    </div>
    <p v-if="savedRules.length" class="tool-select-note">
      Saved patterns or unavailable names (read-only):
      <code v-for="(rule, index) in savedRules" :key="index">{{ rule }}</code>.
      These rules apply in addition to selections and are preserved on save. Edit config.json to change them.
    </p>
  </div>
</template>

<style scoped>
.tool-select { min-width: 0; }
.tool-select-label { display: block; margin-bottom: 6px; font-size: 12px; }
.tool-select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; font-size: 12px; text-align: left; }
.tool-select-options { position: fixed; inset: auto; margin: 0; max-height: 280px; overflow: hidden; padding: 4px; color: var(--text); border: 1px solid var(--border-strong); border-radius: 6px; background: var(--panel); box-shadow: var(--shadow); }
.tool-select-options:popover-open { display: flex; flex-direction: column; }
.tool-select-scroll { min-height: 0; overflow: auto; }
.tool-select-option { display: flex; flex-direction: row; align-items: flex-start; gap: 10px; padding: 10px 8px; border-radius: 4px; cursor: pointer; }
.tool-select-option:hover { background: var(--surface-soft); }
.tool-select-option input { width: auto; flex: none; margin-top: 3px; }
.tool-select-copy { display: grid; gap: 4px; min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
.tool-select-description { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--muted); font-size: 11px; line-height: 1.5; }
.tool-select-note { color: var(--muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.tool-select-note code { margin-right: 6px; }
.tool-select-trigger:disabled, .tool-select-option:has(input:disabled) { opacity: .6; cursor: default; }
</style>
