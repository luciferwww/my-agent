<script setup lang="ts">
import { nextTick, ref } from 'vue';

import type {
  ConversationItem,
  ConversationSegment,
} from '../client/conversation';
import MessageItem from './MessageItem.vue';

const CHAT_FOLLOW_THRESHOLD_PX = 80;

interface HistoryScrollAnchor {
  itemId: string;
  viewportOffset: number;
}

const props = defineProps<{
  currentSessionLabel: string;
  pendingApprovalCount: number;
  isConnected: boolean;
  connectionStatus: string;
  historyStatus: string;
  displayedChatItems: ConversationItem[];
  sessionId: string;
  historyHasMore: boolean;
  historyError: string;
  canRetryHistory: boolean;
}>();

const emit = defineEmits<{
  openSidebar: [];
  loadEarlierHistory: [];
  retryHistory: [];
  resolveApproval: [segment: ConversationSegment, decision: 'allow' | 'deny'];
}>();

const chatLogElement = ref<HTMLElement>();
const mobileSidebarTrigger = ref<HTMLButtonElement>();
const sidebarOpen = ref(false);

function scrollToBottom(sessionId: string, force = false): void {
  const element = chatLogElement.value;
  if (force) {
    nextTick(() => {
      if (sessionId === props.sessionId && chatLogElement.value) {
        chatLogElement.value.scrollTop = chatLogElement.value.scrollHeight;
      }
    });
    return;
  }
  if (sessionId !== props.sessionId || !element) return;
  const initialScrollTop = element.scrollTop;
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (distanceFromBottom > CHAT_FOLLOW_THRESHOLD_PX) return;
  nextTick(() => {
    const currentElement = chatLogElement.value;
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
  const element = chatLogElement.value;
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
    const element = chatLogElement.value;
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
  getMobileSidebarTrigger: () => mobileSidebarTrigger.value,
  setSidebarOpen: (open: boolean) => { sidebarOpen.value = open; },
  scrollToBottom,
  captureHistoryScrollAnchor,
  restoreHistoryScrollAnchor,
});
</script>

<template>
  <div class="chat-top">
    <header class="chat-header">
      <div>
        <h2 class="chat-title">Conversation</h2>
        <p class="chat-subtitle">{{ currentSessionLabel }}</p>
      </div>
      <div class="chat-header-actions">
        <button
          ref="mobileSidebarTrigger"
          class="icon-button mobile-sidebar-trigger"
          type="button"
          title="Open navigation"
          aria-label="Open navigation"
          aria-controls="sidebar-panel"
          :aria-expanded="sidebarOpen"
          @click="emit('openSidebar')"
        >☰</button>
        <div v-if="pendingApprovalCount > 0" class="waiting-badge">
          {{ pendingApprovalCount }} approval request waiting
        </div>
      </div>
    </header>

    <div v-if="!isConnected" class="connection-banner" role="status">
      {{ connectionStatus === 'disconnected'
        ? 'Agent unavailable. Retrying automatically…'
        : 'Connecting to your agent…' }}
    </div>
  </div>

  <section ref="chatLogElement" class="chat-log">
    <div
      v-if="historyStatus === 'loading' && displayedChatItems.length === 0"
      class="empty-state"
    >
      <h3>Loading history…</h3>
    </div>
    <div v-else-if="displayedChatItems.length === 0" class="empty-state">
      <h3>{{ sessionId ? 'Session selected' : 'New Session' }}</h3>
      <p>{{ sessionId
        ? 'Send a message to continue this Session.'
        : 'Send the first message to create this Session.' }}</p>
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
      v-for="item in displayedChatItems"
      :key="item.id"
      :item="item"
      :is-connected="isConnected"
      @resolve-approval="(segment, decision) => emit('resolveApproval', segment, decision)"
    />
  </section>
</template>
