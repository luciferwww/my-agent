<script>
import { nextTick } from 'vue';
import { Check, ChevronDown, Ellipsis, Pencil, Plus, Settings, Trash, X } from '@lucide/vue';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function focusAfterRender(resolveElement) {
  nextTick(() => {
    requestAnimationFrame(() => resolveElement()?.focus());
  });
}

export default {
  components: { Check, ChevronDown, Ellipsis, Pencil, Plus, Settings, Trash, X },
  name: 'SidebarPanel',
  expose: [
    'openMobileSidebar',
    'closeMobileSidebar',
    'closeTransientUi',
  ],
  props: [
    'statusClass',
    'lastStatusMessage',
    'connectionStatusLabel',
    'pendingSessionRequestId',
    'pendingSessionOperation',
    'selectedSessionId',
    'chatItemCount',
    'pendingSessionsRequestId',
    'sessions',
    'sessionsError',
    'isConnected',
    'permissionMode',
    'pendingPermissionRequestId',
    'hasSessionApprovals',
    'formatSessionTime',
    'shortSessionId',
  ],
  emits: [
    'transientUiOpening',
    'sidebarVisibilityChanged',
    'mobileSidebarClosed',
    'startNewSession',
    'selectSession',
    'renameSession',
    'deleteSession',
    'selectPermissionMode',
    'openSettings',
  ],
  data() {
    return {
      sidebarOpen: false,
      isMobileLayout: window.innerWidth <= 980,
      permissionPickerOpen: false,
      permissionPickerPlacement: 'bottom',
      sessionActionMenu: null,
    };
  },
  computed: {
    sessionActionMenuEntry() {
      if (!this.sessionActionMenu) return null;
      return this.sessions.find(
        session => session.sessionId === this.sessionActionMenu.sessionId,
      ) ?? null;
    },
  },
  mounted() {
    window.addEventListener('resize', this.syncResponsiveLayout);
    window.addEventListener('scroll', this.repositionSessionActionMenu, true);
    window.addEventListener('keydown', this.handleGlobalKeydown);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.syncResponsiveLayout);
    window.removeEventListener('scroll', this.repositionSessionActionMenu, true);
    window.removeEventListener('keydown', this.handleGlobalKeydown);
  },
  methods: {
    setSidebarOpen(open) {
      if (this.sidebarOpen === open) return;
      this.sidebarOpen = open;
      this.$emit('sidebarVisibilityChanged', open);
    },
    syncResponsiveLayout() {
      this.isMobileLayout = window.innerWidth <= 980;
      if (!this.isMobileLayout) this.setSidebarOpen(false);
      this.repositionSessionActionMenu();
    },
    openMobileSidebar() {
      if (!this.isMobileLayout || this.sidebarOpen) return;
      this.setSidebarOpen(true);
      focusAfterRender(() => this.$refs.mobileSidebarCloseButton);
    },
    closeMobileSidebar() {
      if (!this.sidebarOpen) return;
      this.closeSessionActionMenu();
      this.setSidebarOpen(false);
      this.$emit('mobileSidebarClosed');
    },
    handleGlobalKeydown(event) {
      if (event.key === 'Escape' && this.sidebarOpen) {
        event.preventDefault();
        this.closeMobileSidebar();
        return;
      }
      if (event.key === 'Tab' && this.sidebarOpen && !this.sessionActionMenu) {
        this.trapMobileSidebarFocus(event);
      }
    },
    trapMobileSidebarFocus(event) {
      const sidebar = this.$refs.sidebarPanel;
      if (!sidebar) return;
      const focusable = [...sidebar.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )].filter(element => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    startNewSession() {
      this.closeSessionActionMenu();
      this.closeMobileSidebar();
      this.$emit('startNewSession');
    },
    selectSession(session) {
      this.closeSessionActionMenu();
      this.closeMobileSidebar();
      this.$emit('selectSession', session);
    },
    toggleSessionActionMenu(session, event) {
      if (!session?.sessionId || !this.isConnected || this.pendingSessionOperation !== null) {
        return;
      }
      if (this.sessionActionMenu?.sessionId === session.sessionId) {
        this.closeSessionActionMenu();
        return;
      }
      this.$emit('transientUiOpening');
      this.positionSessionActionMenu(session.sessionId, event.currentTarget);
      focusAfterRender(() => this.$refs.sessionActionFirstItem);
    },
    positionSessionActionMenu(sessionId, trigger) {
      const rect = trigger.getBoundingClientRect();
      const listRect = trigger.closest('.session-list')?.getBoundingClientRect();
      if (
        listRect
        && (rect.bottom <= Math.max(0, listRect.top)
          || rect.top >= Math.min(window.innerHeight, listRect.bottom))
      ) {
        this.closeSessionActionMenu();
        return;
      }
      const menuWidth = 148;
      const menuHeight = 92;
      const gap = 5;
      const left = clamp(rect.right - menuWidth, 8, window.innerWidth - menuWidth - 8);
      const below = rect.bottom + gap;
      const top = below + menuHeight <= window.innerHeight - 8
        ? below
        : Math.max(8, rect.top - menuHeight - gap);
      this.sessionActionMenu = { sessionId, top, left };
    },
    repositionSessionActionMenu() {
      const sessionId = this.sessionActionMenu?.sessionId;
      if (!sessionId) return;
      const trigger = [...this.$refs.sidebarPanel.querySelectorAll('.session-action-trigger')]
        .find(element => element.dataset.sessionId === sessionId);
      if (!trigger) {
        this.closeSessionActionMenu();
        return;
      }
      this.positionSessionActionMenu(sessionId, trigger);
    },
    closeSessionActionMenu() { this.sessionActionMenu = null; },
    renameSessionFromMenu() {
      const session = this.sessionActionMenuEntry;
      this.closeSessionActionMenu();
      if (session) this.$emit('renameSession', session);
    },
    deleteSessionFromMenu() {
      const session = this.sessionActionMenuEntry;
      this.closeSessionActionMenu();
      if (session) this.$emit('deleteSession', session);
    },
    togglePermissionPicker() {
      if (this.permissionPickerOpen) {
        this.closePermissionPicker();
        return;
      }
      if (!this.isConnected || this.pendingPermissionRequestId !== null) return;
      this.$emit('transientUiOpening');
      this.updatePermissionPickerPlacement(120);
      this.permissionPickerOpen = true;
      nextTick(() => this.updatePermissionPickerPlacement());
    },
    closePermissionPicker() { this.permissionPickerOpen = false; },
    updatePermissionPickerPlacement(estimatedPanelHeight = 120) {
      const trigger = this.$refs.permissionPickerTrigger;
      const panel = this.$refs.permissionPickerPanel;
      const boundary = this.$refs.sidebarPanel;
      if (!trigger || !boundary) return;
      const triggerRect = trigger.getBoundingClientRect();
      const boundaryRect = boundary.getBoundingClientRect();
      const panelHeight = panel?.offsetHeight || estimatedPanelHeight;
      const gap = 8;
      const spaceAbove = triggerRect.top - boundaryRect.top - gap;
      const spaceBelow = boundaryRect.bottom - triggerRect.bottom - gap;
      this.permissionPickerPlacement = (
        spaceBelow < panelHeight && spaceAbove > spaceBelow
      ) ? 'top' : 'bottom';
    },
    selectPermissionMode(mode) {
      this.closePermissionPicker();
      this.$emit('selectPermissionMode', mode);
    },
    closeTransientUi() {
      this.closePermissionPicker();
      this.closeSessionActionMenu();
    },
  },
};
</script>

<template>
<aside
        id="sidebar-panel"
        ref="sidebarPanel"
        class="panel sidebar"
        :class="{ 'is-open': sidebarOpen }"
        :inert="isMobileLayout && !sidebarOpen"
        :aria-hidden="isMobileLayout && !sidebarOpen ? 'true' : null"
        @keydown.escape.stop="closeMobileSidebar"
      >
        <header class="brand">
          <div class="brand-copy">
            <div class="brand-identity">
              <span class="brand-mark" aria-hidden="true"></span>
              <h1 class="brand-title">my-agent</h1>
            </div>
            <p class="brand-subtitle">Personal assistant</p>
          </div>
          <div
            class="status-pill"
            :class="statusClass"
            :title="lastStatusMessage"
            role="status"
          >{{ connectionStatusLabel }}</div>
          <button
            ref="mobileSidebarCloseButton"
            class="icon-button mobile-sidebar-close"
            type="button"
            title="Close navigation"
            aria-label="Close navigation"
            @click="closeMobileSidebar"
          ><X aria-hidden="true" /></button>
        </header>

        <section class="section">
          <div class="section-title">
            <h2>Sessions</h2>
            <div class="section-actions">
              <button
                class="icon-button"
                type="button"
                title="New Session"
                aria-label="New Session"
                @click="startNewSession"
                :disabled="pendingSessionRequestId !== null || (!selectedSessionId && chatItemCount === 0)"
              ><Plus aria-hidden="true" /></button>
            </div>
          </div>
          <div class="session-list" aria-live="polite">
            <div v-if="pendingSessionsRequestId !== null && sessions.length === 0" class="session-list-state">
              Loading Sessions…
            </div>
            <div v-else-if="sessionsError" class="session-list-state error">{{ sessionsError }}</div>
            <div v-else-if="sessions.length === 0" class="session-list-state">
              {{ isConnected ? 'No previous conversations.' : 'Connecting…' }}
            </div>
            <div
              v-for="session in sessions"
              :key="session.sessionId"
              class="session-item"
              :class="{ selected: session.sessionId === selectedSessionId }"
            >
              <button
                class="session-select-button"
                type="button"
                :disabled="pendingSessionRequestId !== null || pendingSessionOperation !== null"
                @click="selectSession(session)"
              >
                <span class="session-item-copy">
                  <span class="session-item-title">{{ session.title || 'Untitled' }}</span>
                  <span v-if="hasSessionApprovals(session.sessionId)" style="color: #ef4444" aria-label="Approval pending" title="Approval pending">●</span>
                </span>
                <span class="session-item-time">{{ formatSessionTime(session.updatedAt) }}</span>
              </button>
              <button
                class="session-action-trigger"
                type="button"
                title="Session actions"
                :aria-label="`Actions for ${session.title || 'Untitled Session'}`"
                aria-haspopup="menu"
                :aria-expanded="sessionActionMenu?.sessionId === session.sessionId"
                :data-session-id="session.sessionId"
                :disabled="!isConnected || pendingSessionRequestId !== null || pendingSessionOperation !== null"
                @click.stop="toggleSessionActionMenu(session, $event)"
                @keydown.escape.stop="closeSessionActionMenu"
              ><Ellipsis aria-hidden="true" /></button>
            </div>
          </div>
          <Teleport to="body">
            <button
              v-if="sessionActionMenu"
              class="session-action-scrim"
              type="button"
              tabindex="-1"
              aria-label="Close Session actions"
              @click="closeSessionActionMenu"
            ></button>
            <div
              v-if="sessionActionMenuEntry"
              class="session-action-menu"
              role="menu"
              :style="{ top: `${sessionActionMenu.top}px`, left: `${sessionActionMenu.left}px` }"
              @keydown.escape.stop="closeSessionActionMenu"
            >
              <button
                ref="sessionActionFirstItem"
                class="session-action-menu-item"
                type="button"
                role="menuitem"
                @click="renameSessionFromMenu"
              >
                <Pencil class="session-action-icon" aria-hidden="true" />
                <span>Rename</span>
              </button>
              <button
                class="session-action-menu-item danger"
                type="button"
                role="menuitem"
                @click="deleteSessionFromMenu"
              >
                <Trash class="session-action-icon" aria-hidden="true" />
                <span>Delete</span>
              </button>
            </div>
          </Teleport>
        </section>

        <section class="section permission-panel">
          <div class="section-title">
            <h2>Session permissions</h2>
          </div>
          <div class="model-picker" :class="{ open: permissionPickerOpen }">
            <span class="field-label-text">Permission mode</span>
            <button
              ref="permissionPickerTrigger"
              class="model-picker-trigger"
              type="button"
              :disabled="!isConnected || pendingPermissionRequestId !== null"
              :aria-expanded="String(permissionPickerOpen)"
              aria-haspopup="listbox"
              @click="togglePermissionPicker"
            >
              <span class="model-picker-trigger-copy">
                <span class="model-picker-trigger-name">
                  {{ permissionMode === 'allow_all' ? 'Allow all for this Session' : 'Manual permissions' }}
                </span>
              </span>
              <ChevronDown class="model-picker-chevron" aria-hidden="true" />
            </button>
            <div v-if="permissionPickerOpen" class="model-picker-scrim" @click="closePermissionPicker"></div>
            <div
              v-if="permissionPickerOpen"
              ref="permissionPickerPanel"
              class="model-picker-panel permission-picker-panel"
              :class="{ 'placement-top': permissionPickerPlacement === 'top' }"
              role="listbox"
              aria-label="Permission mode"
              @keydown.esc.stop="closePermissionPicker"
            >
              <button
                class="model-picker-option"
                :class="{ selected: permissionMode === 'manual' }"
                type="button"
                role="option"
                :aria-selected="String(permissionMode === 'manual')"
                @click="selectPermissionMode('manual')"
              >
                <span class="model-picker-check" aria-hidden="true"><Check v-if="permissionMode === 'manual'" /></span>
                <span class="model-picker-option-copy">
                  <span class="model-picker-option-name">Manual permissions</span>
                  <span class="model-picker-option-id">Ask before protected tool calls</span>
                </span>
              </button>
              <button
                class="model-picker-option"
                :class="{ selected: permissionMode === 'allow_all' }"
                type="button"
                role="option"
                :aria-selected="String(permissionMode === 'allow_all')"
                @click="selectPermissionMode('allow_all')"
              >
                <span class="model-picker-check" aria-hidden="true"><Check v-if="permissionMode === 'allow_all'" /></span>
                <span class="model-picker-option-copy">
                  <span class="model-picker-option-name">Allow all for this Session</span>
                  <span class="model-picker-option-id">Run every non-denied tool without asking</span>
                </span>
              </button>
            </div>
          </div>
          <div
            class="permission-indicator"
            :class="{ 'allow-all': permissionMode === 'allow_all' }"
            aria-live="polite"
          >
            Active: {{ permissionMode === 'allow_all' ? 'Allow all for this Session' : 'Manual permissions' }}
          </div>
          <p v-if="permissionMode === 'allow_all'" class="permission-warning">
            Tools can run without asking and may change files or execute commands. This stays
            active for the Session until you switch it off.
          </p>
        </section>
        <button type="button" class="sidebar-settings" @click="$emit('openSettings')">
          <Settings aria-hidden="true" />
          <span class="model-picker-trigger-name">Settings</span>
        </button>
      </aside>

      <button
        v-if="isMobileLayout && sidebarOpen"
        class="mobile-sidebar-scrim"
        type="button"
        tabindex="-1"
        aria-label="Close navigation"
        @click="closeMobileSidebar"
      ></button>

</template>
