<script setup lang="ts">
import { nextTick, ref } from 'vue';

import type { ConversationItem } from '../client/conversation';
import MessageItem from './MessageItem.vue';

const CHILD_FOLLOW_THRESHOLD_PX = 80;

interface HistoryScrollAnchor {
  itemId: string;
  viewportOffset: number;
}

const props = defineProps<{
  sessionId: string;
  subscriptionStatus: string;
  unavailable: boolean;
  historyStatus: string;
  historyError: string;
  historyHasMore: boolean;
  canRetryHistory: boolean;
  displayedItems: ConversationItem[];
}>();

const emit = defineEmits<{
  close: [];
  loadEarlierHistory: [];
  retryHistory: [];
}>();

const childLogElement = ref<HTMLElement>();

function scrollToBottom(sessionId: string, force = false): void {
  const element = childLogElement.value;
  if (force) {
    nextTick(() => {
      if (sessionId === props.sessionId && childLogElement.value) {
        childLogElement.value.scrollTop = childLogElement.value.scrollHeight;
      }
    });
    return;
  }
  if (sessionId !== props.sessionId || !element) return;
  const initialScrollTop = element.scrollTop;
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (distanceFromBottom > CHILD_FOLLOW_THRESHOLD_PX) return;
  nextTick(() => {
    const currentElement = childLogElement.value;
    if (
      sessionId !== props.sessionId
      || !currentElement
      || currentElement.scrollTop < initialScrollTop
    ) {
      return;
    }
    currentElement.scrollTop = currentElement.scrollHeight;
  });
}

function captureHistoryScrollAnchor(sessionId: string): HistoryScrollAnchor | null {
  const element = childLogElement.value;
  if (sessionId !== props.sessionId || !element) return null;
  const containerRect = element.getBoundingClientRect();
  const anchor = [...element.querySelectorAll<HTMLElement>('[data-chat-item-id]')]
    .find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    });
  const itemId = anchor?.dataset.chatItemId;
  if (!anchor || !itemId) return null;
  return {
    itemId,
    viewportOffset: anchor.getBoundingClientRect().top - containerRect.top,
  };
}

function restoreHistoryScrollAnchor(
  sessionId: string,
  anchor: HistoryScrollAnchor | null,
): void {
  if (!anchor || sessionId !== props.sessionId) return;
  nextTick(() => {
    const element = childLogElement.value;
    if (sessionId !== props.sessionId || !element) return;
    const anchoredElement = [...element.querySelectorAll<HTMLElement>('[data-chat-item-id]')]
      .find(candidate => candidate.dataset.chatItemId === anchor.itemId);
    if (!anchoredElement) return;
    const containerTop = element.getBoundingClientRect().top;
    const viewportOffset = anchoredElement.getBoundingClientRect().top - containerTop;
    element.scrollTop += viewportOffset - anchor.viewportOffset;
  });
}

defineExpose({
  scrollToBottom,
  captureHistoryScrollAnchor,
  restoreHistoryScrollAnchor,
});
</script>

<template>
  <div class="child-detail-scrim" @click.self="emit('close')">
    <aside class="child-detail" aria-label="Subagent detail">
      <header class="child-detail-header">
        <div>
          <div class="eyebrow">Read-only Subagent</div>
          <h2>Child Session</h2>
          <p>{{ sessionId }}</p>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close Subagent detail"
          title="Close detail"
          @click="emit('close')"
        >×</button>
      </header>

      <div v-if="unavailable" class="child-detail-unavailable" role="status">
        <h3>Child content unavailable</h3>
        <p>This retained Child Session has expired or is no longer available.</p>
      </div>
      <div v-else-if="subscriptionStatus !== 'subscribed'" class="child-detail-unavailable" role="status">
        <h3>{{ subscriptionStatus === 'subscribing' ? 'Opening Child Session…' : 'Child Session disconnected' }}</h3>
        <p v-if="subscriptionStatus !== 'subscribing'">
          Reconnect to restore this read-only detail.
        </p>
      </div>
      <section v-else ref="childLogElement" class="child-detail-log">
        <div
          v-if="historyStatus === 'loading' && displayedItems.length === 0"
          class="empty-state"
        >
          <h3>Loading Child history…</h3>
        </div>
        <div v-else-if="displayedItems.length === 0" class="empty-state">
          <h3>Child Session active</h3>
          <p>Waiting for Subagent activity.</p>
        </div>

        <div v-if="historyHasMore" class="button-row">
          <button
            class="secondary"
            :disabled="historyStatus === 'loading' || historyStatus === 'error'"
            @click="emit('loadEarlierHistory')"
          >
            {{ historyStatus === 'loading' ? 'Loading…' : 'Load earlier messages' }}
          </button>
        </div>

        <div v-if="historyError" class="session-list-state error">
          <div>{{ historyError }}</div>
          <button
            v-if="canRetryHistory"
            class="secondary"
            :disabled="historyStatus === 'loading'"
            @click="emit('retryHistory')"
          >
            {{ historyStatus === 'loading' ? 'Retrying…' : 'Retry history' }}
          </button>
        </div>

        <MessageItem
          v-for="item in displayedItems"
          :key="item.id"
          :item="item"
          :is-connected="false"
          opened-child-session-id=""
        />
      </section>
    </aside>
  </div>
</template>
