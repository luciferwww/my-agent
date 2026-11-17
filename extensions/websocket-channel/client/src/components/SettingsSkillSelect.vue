<script setup lang="ts">
import { computed } from 'vue';
import type { SettingsSkill } from '../client/settings';

const props = defineProps<{
  modelValue: string[];
  skills: SettingsSkill[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [names: string[]] }>();
const missing = computed(() => props.modelValue.filter(name => !props.skills.some(skill => skill.name === name)));
function toggle(name: string) {
  emit('update:modelValue', props.modelValue.includes(name)
    ? props.modelValue.filter(value => value !== name) : [...props.modelValue, name]);
}
</script>

<template>
  <fieldset class="skill-options" :disabled="disabled">
    <legend>Skills</legend>
    <p v-if="!skills.length">No available Skills found.</p>
    <label v-for="skill in skills" :key="skill.name" class="skill-option">
      <input type="checkbox" :checked="modelValue.includes(skill.name)" @change="toggle(skill.name)">
      <span><strong>{{ skill.name }}</strong><small>{{ skill.description }}</small><small>{{ skill.relativeDirectory }}</small></span>
    </label>
    <label v-for="name in missing" :key="name" class="skill-option">
      <input type="checkbox" checked @change="toggle(name)">
      <span>{{ name }} (unavailable)</span>
    </label>
  </fieldset>
</template>

<style scoped>
.skill-options { border: 1px solid var(--border); border-radius: 8px; padding: 12px; min-width: 0; }
.skill-option { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0; overflow-wrap: anywhere; }
.skill-option input { width: auto; margin-top: 3px; flex-shrink: 0; }
.skill-option span { min-width: 0; }
.skill-option small { display: block; color: var(--muted); margin-top: 4px; }
</style>
