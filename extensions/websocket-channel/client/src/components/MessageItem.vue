<script setup lang="ts">
import {
  approvalStatusClass,
  approvalStatusLabel,
  formatBytes,
  formatReasoningSummary,
  formatTime,
  itemRoleClass,
  prettyJson,
  segmentResultPreview,
  toolInputSummary,
  toolStatusLabel,
  type ConversationItem,
  type ConversationSegment,
} from '../client/conversation';
import { renderAssistantMarkdown } from '../client/markdown';

defineProps<{
  item: ConversationItem;
  isConnected: boolean;
  openedChildSessionId: string;
}>();

const emit = defineEmits<{
  resolveApproval: [segment: ConversationSegment, decision: 'allow' | 'deny'];
  openSubagent: [sessionId: string];
}>();

function openSubagentFromCard(
  event: MouseEvent | KeyboardEvent,
  segment: ConversationSegment,
): void {
  if (!segment.subagentSessionId) return;
  if (event.target !== event.currentTarget && event.target instanceof Element) {
    if (event.target.closest('button')) return;
  }
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
  if (event instanceof KeyboardEvent) event.preventDefault();
  emit('openSubagent', segment.subagentSessionId);
}
</script>

<template>
  <article
    :data-chat-item-id="item.id"
    class="message"
    :class="[itemRoleClass(item), { 'is-interrupted': item.kind === 'turn' && item.interrupted }]"
  >
    <div class="message-meta">
      <span>{{ item.label }}</span>
      <span v-if="item.kind === 'user' && item.isSteer" class="meta-tag">steer</span>
      <span v-if="item.kind === 'turn' && item.isContinuation" class="meta-tag meta-tag-muted">continued</span>
      <span v-if="item.kind === 'turn' && item.interrupted" class="meta-tag meta-tag-warn">steered</span>
      <span v-if="item.turnId">turn {{ item.turnId.slice(0, 8) }}</span>
      <span>{{ formatTime(item.timestamp) }}</span>
    </div>

    <template v-if="item.kind === 'turn'">
      <template v-for="segment in item.segments" :key="segment.id">
        <div v-if="segment.type === 'text'" class="bubble">
          <div class="rich-text" v-html="renderAssistantMarkdown(segment.text)"></div>
        </div>

        <section v-if="segment.type === 'thinking'" class="thinking-card">
          <button
            class="thinking-header"
            type="button"
            :aria-expanded="Boolean(segment.expanded)"
            @click="segment.expanded = !segment.expanded"
          >
            <span>{{ segment.status === 'running' ? 'Thinking…' : 'Thinking' }}</span>
            <span>{{ segment.expanded ? '⌃' : '⌄' }}</span>
          </button>
          <pre v-if="segment.expanded" class="thinking-text">{{ segment.text }}</pre>
        </section>

        <section
          v-if="segment.type === 'tool_call'"
          class="tool-result-card"
          :class="{
            'is-error': segment.isError,
            'has-subagent-detail': Boolean(segment.subagentSessionId),
            'is-subagent-selected': segment.subagentSessionId === openedChildSessionId,
          }"
          :tabindex="segment.subagentSessionId ? 0 : undefined"
          :aria-label="segment.subagentSessionId ? `Open ${segment.name} Subagent detail` : undefined"
          @click="openSubagentFromCard($event, segment)"
          @keydown="openSubagentFromCard($event, segment)"
        >
          <div class="tool-result-header">
            <div class="tool-result-title">
              <span class="tool-result-name">{{ segment.name }}</span>
              <span class="tool-result-badge">{{ toolStatusLabel(segment.status) }}</span>
            </div>
            <button
              class="tool-card-toggle"
              type="button"
              :aria-expanded="Boolean(segment.expanded)"
              @click="segment.expanded = !segment.expanded"
            >{{ segment.expanded ? '⌃' : '⌄' }}</button>
          </div>
          <div
            v-if="!segment.expanded"
            class="tool-card-summary"
            :title="toolInputSummary(segment.input)"
          >{{ toolInputSummary(segment.input) }}</div>
          <template v-else>
            <div class="tool-card-section-label">Input</div>
            <div class="tool-result-preview">
              <pre class="tool-result-scroll">{{ prettyJson(segment.input) }}</pre>
            </div>
            <template v-if="segment.resultContent">
              <div class="tool-card-section-label">{{ segment.isError ? 'Error' : 'Result' }}</div>
              <div v-if="!segment.resultExpanded" class="tool-result-preview">
                <pre class="tool-result-scroll">{{ segmentResultPreview(segment).text }}</pre>
              </div>
              <div v-else class="tool-result-body">
                <pre class="tool-result-scroll">{{ segment.resultContent }}</pre>
              </div>
              <button
                v-if="segmentResultPreview(segment).omittedCount > 0"
                class="secondary"
                @click="segment.resultExpanded = !segment.resultExpanded"
              >{{ segment.resultExpanded ? 'Show preview' : 'Show full result' }}</button>
            </template>
          </template>
          <div
            v-if="isConnected && segment.approval?.status === 'pending'"
            class="approval-actions"
          >
            <button class="secondary" @click="emit('resolveApproval', segment, 'deny')">Deny</button>
            <button class="primary" @click="emit('resolveApproval', segment, 'allow')">Allow</button>
          </div>
        </section>

        <section
          v-if="segment.type === 'approval' && segment.approval"
          class="approval-card"
          :class="[segment.approval.status, { collapsed: !segment.expanded }]"
        >
          <div class="tool-result-header">
            <div>
              <div class="eyebrow">Approval Required</div>
              <div class="approval-title-row">
                <h3>{{ segment.approval.toolName }}</h3>
                <div
                  class="approval-status"
                  :class="approvalStatusClass(segment.approval.status)"
                >{{ approvalStatusLabel(segment.approval.status) }}</div>
              </div>
            </div>
            <button
              class="tool-card-toggle"
              type="button"
              :aria-expanded="Boolean(segment.expanded)"
              @click="segment.expanded = !segment.expanded"
            >{{ segment.expanded ? '⌃' : '⌄' }}</button>
          </div>
          <div
            v-if="!segment.expanded"
            class="tool-card-summary"
            :title="toolInputSummary(segment.approval.input)"
          >{{ toolInputSummary(segment.approval.input) }}</div>
          <template v-else>
            <div class="approval-meta">
              <span>ID: {{ segment.approval.id }}</span>
            </div>
            <div class="tool-card-section-label">Input</div>
            <pre class="approval-code">{{ prettyJson(segment.approval.input) }}</pre>
          </template>
          <div
            v-if="isConnected && segment.approval.status === 'pending'"
            class="approval-actions"
          >
            <button class="secondary" @click="emit('resolveApproval', segment, 'deny')">Deny</button>
            <button class="primary" @click="emit('resolveApproval', segment, 'allow')">Allow</button>
          </div>
        </section>
      </template>
    </template>

    <template v-else>
      <div class="bubble">
        <div v-if="item.text" class="bubble-text">{{ item.text }}</div>
        <div v-if="item.attachments?.length" class="bubble-attachments">
          <div v-for="attachment in item.attachments" :key="attachment.id" class="bubble-attachment">
            <img :src="attachment.previewUrl" :alt="attachment.name" />
            <div class="bubble-attachment-meta">
              <span>{{ attachment.name }}</span>
              <span>{{ formatBytes(attachment.sizeBytes) }}{{ attachment.willResize ? ' · compressed' : '' }}</span>
            </div>
          </div>
        </div>
        <div v-if="item.attachmentSummaries?.length" class="bubble-attachments">
          <div
            v-for="(summary, index) in item.attachmentSummaries"
            :key="index"
            class="attachment-chip"
          >
            <div class="attachment-chip-meta">
              <span class="attachment-chip-name">{{ summary.type }}{{ summary.mime ? ' · ' + summary.mime : '' }}</span>
              <span v-if="summary.bytes != null" class="attachment-chip-size">{{ formatBytes(summary.bytes) }}</span>
            </div>
          </div>
        </div>
        <div v-if="item.kind === 'user'" class="reasoning-summary">
          {{ formatReasoningSummary(item.reasoning) }}
        </div>
      </div>
    </template>
  </article>
</template>
