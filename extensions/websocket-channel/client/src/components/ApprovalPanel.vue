<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { prettyJson, type PendingApproval } from '../client/conversation';

const props = defineProps<{
  sessionId: string;
  approvals: PendingApproval[];
  sources: Record<string, string>;
  isConnected: boolean;
}>();
const emit = defineEmits<{
  resolveApproval: [id: string, decision: 'allow' | 'deny'];
}>();

const selectedId = ref<string>();
const selectedIndex = computed(() => Math.max(0,
  props.approvals.findIndex(request => request.id === selectedId.value)));
const selected = computed(() => props.approvals[selectedIndex.value]);

watch(() => props.sessionId, () => { selectedId.value = undefined; }, { flush: 'sync' });
watch(() => props.approvals.map(request => request.id), (ids, previous) => {
  if (selectedId.value && ids.includes(selectedId.value)) return;
  const index = previous?.indexOf(selectedId.value ?? '') ?? 0;
  selectedId.value = ids[Math.min(Math.max(0, index), ids.length - 1)];
}, { immediate: true, flush: 'sync' });

function move(offset: number): void {
  const request = props.approvals[selectedIndex.value + offset];
  if (request) selectedId.value = request.id;
}
</script>

<template>
  <section v-if="selected" class="approval-deck" aria-label="Pending approvals">
    <header class="approval-deck-header">
      <strong>Approval required</strong>
      <nav v-if="approvals.length > 1" class="approval-deck-navigation" aria-label="Approval navigation">
        <button type="button" class="secondary" aria-label="Previous approval"
          :disabled="selectedIndex === 0" @click="move(-1)">&lt;</button>
        <span aria-live="polite">{{ selectedIndex + 1 }} / {{ approvals.length }}</span>
        <button type="button" class="secondary" aria-label="Next approval"
          :disabled="selectedIndex === approvals.length - 1" @click="move(1)">&gt;</button>
      </nav>
    </header>
    <div :key="selected.id" class="approval-deck-request" :data-approval-id="selected.id">
      <div class="approval-deck-source">{{ sources[selected.id] ?? 'Source unavailable' }}</div>
      <div class="tool-result-name">{{ selected.toolName }}</div>
      <pre class="approval-deck-input">{{ prettyJson(selected.input) }}</pre>
      <div class="approval-actions">
        <span v-if="!isConnected" role="status">Reconnect to respond</span>
        <button type="button" class="secondary" :disabled="!isConnected"
          @click="emit('resolveApproval', selected!.id, 'deny')">Deny</button>
        <button type="button" class="primary" :disabled="!isConnected"
          @click="emit('resolveApproval', selected!.id, 'allow')">Allow</button>
      </div>
    </div>
  </section>
</template>
