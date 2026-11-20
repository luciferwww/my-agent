<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Eye, EyeOff } from '@lucide/vue';
import { credentialDraft, SAVED_CREDENTIAL_MASK, type CredentialMetadata, type SecretDraft } from '../client/settings';

export type { SecretDraft } from '../client/settings';
const props = defineProps<{ label: string; metadata: CredentialMetadata; modelValue: SecretDraft }>();
const emit = defineEmits<{ 'update:modelValue': [value: SecretDraft] }>();
const revealed = ref(false);
const keeping = computed(() => props.modelValue.operation === 'keep' && props.metadata.configured);
const value = computed(() => keeping.value ? SAVED_CREDENTIAL_MASK : props.modelValue.value);
const canReveal = computed(() => props.modelValue.operation === 'replace' && props.modelValue.value.length > 0);
watch(canReveal, (allowed) => { if (!allowed) revealed.value = false; });
function changeValue(event: Event) {
  if (event.target instanceof HTMLInputElement) {
    emit('update:modelValue', credentialDraft(event.target.value, props.metadata.configured));
  }
}
</script>

<template>
  <label class="credential-field">
    {{ label }} ({{ metadata.configured ? `configured: ${metadata.source || 'unknown source'}` : 'not configured' }})
    <span v-if="metadata.error" role="alert">Invalid saved credential; replace or clear it.</span>
    <span class="credential-input">
      <input :type="revealed && canReveal ? 'text' : 'password'" autocomplete="new-password"
        :value="value" placeholder="API key or ${ENV}" spellcheck="false" autocapitalize="off" @input="changeValue">
      <button type="button" class="icon-button credential-eye" :disabled="!canReveal"
        :aria-label="revealed ? 'Hide new credential' : 'Show new credential'" :aria-pressed="revealed"
        title="Show or hide new input; saved credentials are never revealed" @click="revealed = !revealed">
        <component :is="revealed ? Eye : EyeOff" aria-hidden="true" />
      </button>
    </span>
    <small v-if="keeping">Saved value retained. Replace the mask to change it, or delete it to remove the credential.</small>
    <small v-else-if="modelValue.operation === 'clear' && metadata.configured">Credential will be removed when this section is saved.</small>
    <small v-else-if="modelValue.operation === 'replace'">
      {{ modelValue.value ? 'New value will replace the saved credential.' : 'Replacement input was cleared. Re-enter it before submitting.' }}
    </small>
  </label>
</template>

<style scoped>
.credential-input { position: relative; display: block; }
.credential-input input { padding-right: 44px; }
.credential-eye { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); }
.credential-eye:hover:not(:disabled) { transform: translateY(-50%); }
.credential-eye svg { width: 18px; height: 18px; }
small { color: var(--muted); font-size: 11px; font-weight: normal; }
</style>
