<script setup lang="ts">
import { ref } from 'vue';

interface Attachment {
  readonly id: string | number;
  readonly name: string;
  readonly previewUrl: string;
  readonly sizeBytes: number;
  readonly willResize: boolean;
}

const props = defineProps<{
  modelValue: string;
  attachments: Attachment[];
  attachError: string;
  selectedModelSupportsImages: boolean;
  attachmentCapabilityExplanation: string;
  isWaitingForReply: boolean;
  maxAttachmentsPerMessage: number;
  isConnected: boolean;
  canSend: boolean;
  pendingApprovalCount: number;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  files: [files: FileList | File[]];
  removeAttachment: [id: string | number];
  reset: [];
  abort: [];
  send: [];
}>();

const fileInput = ref<HTMLInputElement>();
const dragDepth = ref(0);
const dragHover = ref(false);

function onPaste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0) emit('files', files);
}

function onDragEnter(event: DragEvent): void {
  event.preventDefault();
  dragDepth.value += 1;
  dragHover.value = true;
}

function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
  if (dragDepth.value === 0) dragHover.value = false;
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragDepth.value = 0;
  dragHover.value = false;
  if (event.dataTransfer?.files.length) emit('files', event.dataTransfer.files);
}

function onFileInputChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) emit('files', input.files);
  input.value = '';
}

function updateDraft(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <footer
    class="composer"
    :class="{ 'is-dragging': dragHover }"
    @dragenter="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      v-if="attachments.length > 0 || attachError || !selectedModelSupportsImages"
      class="composer-attachments"
    >
      <div v-if="attachError" class="composer-attach-error">{{ attachError }}</div>
      <div v-if="!selectedModelSupportsImages" class="composer-attach-error">
        {{ attachmentCapabilityExplanation }}
      </div>
      <div v-if="attachments.length > 0" class="attachment-chip-row">
        <div v-for="attachment in attachments" :key="attachment.id" class="attachment-chip">
          <img :src="attachment.previewUrl" :alt="attachment.name" />
          <div class="attachment-chip-meta">
            <span class="attachment-chip-name">{{ attachment.name }}</span>
            <span class="attachment-chip-size">{{ formatBytes(attachment.sizeBytes) }}</span>
            <span v-if="attachment.willResize" class="attachment-chip-badge">Compressed</span>
          </div>
          <button
            class="attachment-chip-remove"
            aria-label="Remove attachment"
            @click="emit('removeAttachment', attachment.id)"
          >×</button>
        </div>
      </div>
      <div
        v-if="isWaitingForReply && attachments.length > 0"
        class="composer-attach-error"
      >
        Steering messages cannot include attachments. Remove them before sending.
      </div>
    </div>

    <label>
      Message
      <textarea
        :value="modelValue"
        placeholder="Send a message to the agent…"
        @input="updateDraft"
        @keydown.enter.exact.prevent="emit('send')"
        @paste="onPaste"
      ></textarea>
    </label>

    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      hidden
      @change="onFileInputChange"
    />

    <div class="composer-row">
      <div class="composer-hint">
        <span>Press Enter to send or Shift+Enter for a new line. Attach up to {{ maxAttachmentsPerMessage }} images (10 MB total) by button, drop, or paste.</span>
      </div>
      <div class="button-row">
        <button
          class="secondary"
          :disabled="!isConnected || isWaitingForReply || !selectedModelSupportsImages"
          :title="isWaitingForReply ? 'Steering does not support attachments' : attachmentCapabilityExplanation"
          @click="fileInput?.click()"
        >📎 Images</button>
        <button
          class="secondary"
          :disabled="!modelValue && attachments.length === 0"
          @click="emit('reset')"
        >Reset</button>
        <button
          v-if="isWaitingForReply"
          class="secondary abort-btn"
          :disabled="!isConnected"
          title="Abort the current turn and discard queued messages"
          @click="emit('abort')"
        >⏹ Stop</button>
        <button class="primary" :disabled="!canSend" @click="emit('send')">
          {{ pendingApprovalCount > 0 ? 'Approval pending…' : isWaitingForReply ? 'Steer' : 'Send' }}
        </button>
      </div>
    </div>
  </footer>
</template>
