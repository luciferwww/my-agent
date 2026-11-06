<script setup lang="ts">
import {
  approvalStatusClass,
  approvalStatusLabel,
  formatBytes,
  formatReasoningSummary,
  formatTime,
  groupConversationSegments,
  itemRoleClass,
  prettyJson,
  segmentResultPreview,
  toolInputSummary,
  toolStatusLabel,
  type ConversationItem,
  type ConversationSegment,
} from '../client/conversation';
import { renderAssistantMarkdown } from '../client/markdown';
import type { SubagentScope } from '../client/history';

const props = defineProps<{
  item: ConversationItem;
  isConnected: boolean;
  sourceSessionId: string;
  itemsBySession: Record<string, ConversationItem[]>;
  scopes: SubagentScope[];
}>();

function childScope(segment: ConversationSegment): SubagentScope | undefined {
  return props.scopes.find(scope =>
    scope.callerSessionId === props.sourceSessionId
    && scope.parentTurnId === props.item.turnId
    && scope.parentToolUseId === segment.callId);
}

function childSessionId(segment: ConversationSegment): string | undefined {
  return childScope(segment)?.sessionId ?? segment.subagentSessionId;
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
      <section
        v-for="block in groupConversationSegments(item.segments ?? [])"
        :key="block.id"
        :class="block.group ? 'tool-call-group' : 'message-segment'"
        :data-tool-group-id="block.group?.id"
        :data-llm-round="block.group?.round"
      >
        <button
          v-if="block.group"
          class="tool-group-header"
          type="button"
          :aria-expanded="block.group.expanded"
          @click="block.group.expanded = !block.group.expanded"
        >
          <span class="tool-group-title">LLM call {{ block.group.round + 1 }}</span>
          <span>{{ block.segments.length }} tool{{ block.segments.length === 1 ? '' : 's' }}</span>
          <span v-if="block.segments.some(segment => segment.approval?.status === 'pending')">
            Approval required
          </span>
          <span>{{ block.group.expanded ? '⌃' : '⌄' }}</span>
        </button>
        <template
          v-for="segment in block.group?.expanded === false ? [] : block.segments"
          :key="segment.id"
        >
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
          :class="{ 'is-error': segment.isError }"
          :data-tool-call-id="segment.callId"
        >
          <div class="tool-result-header">
            <div class="tool-result-title">
              <span class="tool-result-name">{{ segment.name }}</span>
              <span class="tool-result-badge" :data-status="segment.status">
                {{ toolStatusLabel(segment.status) }}
              </span>
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
          <section
            v-if="childSessionId(segment)"
            class="subagent-execution"
            :data-subagent-session-id="childSessionId(segment)"
            :data-subagent-status="childScope(segment)?.status ?? segment.subagentStatus ?? 'unknown'"
          >
            <button
              class="subagent-header"
              type="button"
              :aria-expanded="segment.subagentExpanded !== false"
              @click="segment.subagentExpanded = segment.subagentExpanded === false"
            >
              <span>{{ childScope(segment)?.subagentType ?? 'Subagent' }}</span>
              <span
                class="tool-result-badge"
                :data-status="childScope(segment)?.outcome ?? segment.subagentOutcome
                  ?? childScope(segment)?.status ?? segment.subagentStatus"
              >
                {{ childScope(segment)?.outcome ?? segment.subagentOutcome
                  ?? childScope(segment)?.status ?? segment.subagentStatus ?? 'unknown' }}
              </span>
              <span>{{ segment.subagentExpanded === false ? '⌄' : '⌃' }}</span>
            </button>
            <div v-if="segment.subagentExpanded !== false" class="subagent-content">
              <MessageItem
                v-for="childItem in itemsBySession[childSessionId(segment)!] ?? []"
                :key="childItem.id"
                :item="childItem"
                :source-session-id="childSessionId(segment)!"
                :items-by-session="itemsBySession"
                :scopes="scopes"
                :is-connected="isConnected"
              />
              <p
                v-if="!itemsBySession[childSessionId(segment)!]?.length"
                class="subagent-empty"
              >{{ childScope(segment)?.status === 'running'
                ? 'Waiting for Subagent output…'
                : 'No retained Subagent output.' }}</p>
            </div>
          </section>
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
        </section>
        </template>
      </section>
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
