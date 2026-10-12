<script>
import { nextTick } from 'vue';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function focusAfterRender(resolveElement) {
  nextTick(() => {
    requestAnimationFrame(() => resolveElement()?.focus());
  });
}

export default {
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
    'modelCatalog',
    'availableModels',
    'availableModelProviders',
    'modelPickerLabel',
    'selectedModelDetails',
    'showThinkingControl',
    'showEffortControl',
    'reasoningSelection',
    'reasoningNotice',
    'reasoningConstraintNotice',
    'pendingSessionRequestId',
    'pendingSessionOperation',
    'selectedSessionId',
    'chatItemCount',
    'pendingSessionsRequestId',
    'sessions',
    'sessionsError',
    'isConnected',
    'permissionMode',
    'theme',
    'pendingPermissionRequestId',
    'formatReasoningOption',
    'reasoningPickerOptions',
    'isReasoningPickerOptionDisabled',
    'modelOptionToken',
    'isSelectedModel',
    'isRuntimeDefaultModel',
    'hasSessionApprovals',
    'formatSessionTime',
    'shortSessionId',
  ],
  emits: [
    'sidebarVisibilityChanged',
    'mobileSidebarClosed',
    'selectModel',
    'selectReasoningOption',
    'startNewSession',
    'selectSession',
    'renameSession',
    'deleteSession',
    'selectPermissionMode',
    'selectTheme',
  ],
  data() {
    return {
      sidebarOpen: false,
      isMobileLayout: window.innerWidth <= 980,
      modelPickerOpen: false,
      reasoningPickerOpen: null,
      themePickerOpen: false,
      permissionPickerOpen: false,
      permissionPickerPlacement: 'bottom',
      modelSearch: '',
      activeModelOptionIndex: -1,
      sessionActionMenu: null,
    };
  },
  computed: {
    filteredModelProviders() {
      const query = this.modelSearch.trim().toLocaleLowerCase();
      if (!query) return this.availableModelProviders;
      return this.availableModelProviders.flatMap(provider => {
        const providerMatches = `${provider.displayName} ${provider.providerId}`
          .toLocaleLowerCase()
          .includes(query);
        const models = providerMatches
          ? provider.models
          : provider.models.filter(model => `${model.displayName} ${model.modelId}`
              .toLocaleLowerCase()
              .includes(query));
        return models.length > 0 ? [{ ...provider, models }] : [];
      });
    },
    filteredModelOptions() {
      return this.filteredModelProviders.flatMap(provider => provider.models.map(model => ({
        providerId: provider.providerId,
        modelId: model.modelId,
      })));
    },
    activeModelOptionId() {
      return this.activeModelOptionIndex >= 0
        && this.activeModelOptionIndex < this.filteredModelOptions.length
        ? `model-picker-option-${this.activeModelOptionIndex}`
        : null;
    },
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
    toggleModelPicker() {
      if (this.modelPickerOpen) {
        this.closeModelPicker();
        return;
      }
      if (!this.modelCatalog || this.availableModels.length === 0) return;
      this.closeThemePicker();
      this.closePermissionPicker();
      this.closeReasoningPicker();
      this.modelSearch = '';
      this.modelPickerOpen = true;
      this.activeModelOptionIndex = this.modelOptionIndex(
        this.selectedModelDetails?.reference?.providerId,
        this.selectedModelDetails?.reference?.modelId,
      );
      focusAfterRender(() => {
        this.scrollActiveModelOptionIntoView();
        return this.$refs.modelSearchEl;
      });
    },
    closeModelPicker() {
      this.modelPickerOpen = false;
      this.modelSearch = '';
      this.activeModelOptionIndex = -1;
    },
    onModelSearchInput(event) {
      this.modelSearch = event.target.value;
      nextTick(() => {
        this.activeModelOptionIndex = this.filteredModelOptions.length > 0 ? 0 : -1;
        this.scrollActiveModelOptionIntoView();
      });
    },
    onModelSearchKeydown(event) {
      const options = this.filteredModelOptions;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.activeModelOptionIndex = options.length === 0
          ? -1
          : Math.min(this.activeModelOptionIndex + 1, options.length - 1);
        this.scrollActiveModelOptionIntoView();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.activeModelOptionIndex = options.length === 0
          ? -1
          : Math.max(this.activeModelOptionIndex - 1, 0);
        this.scrollActiveModelOptionIntoView();
        return;
      }
      if (event.key === 'Enter' && options.length > 0) {
        event.preventDefault();
        const option = options[clamp(this.activeModelOptionIndex, 0, options.length - 1)];
        this.selectModel(option.providerId, option.modelId);
      }
    },
    activateModelOption(providerId, modelId) {
      this.activeModelOptionIndex = this.modelOptionIndex(providerId, modelId);
    },
    modelOptionIndex(providerId, modelId) {
      return this.filteredModelOptions.findIndex(option =>
        option.providerId === providerId && option.modelId === modelId);
    },
    modelOptionId(providerId, modelId) {
      const index = this.modelOptionIndex(providerId, modelId);
      return index >= 0 ? `model-picker-option-${index}` : undefined;
    },
    scrollActiveModelOptionIntoView() {
      nextTick(() => {
        this.$refs.modelSearchEl
          ?.closest('.model-picker-panel')
          ?.querySelector('.model-picker-option.active')
          ?.scrollIntoView({ block: 'nearest' });
      });
    },
    selectModel(providerId, modelId) {
      this.closeModelPicker();
      this.$emit('selectModel', providerId, modelId);
    },
    toggleReasoningPicker(kind) {
      if (this.reasoningPickerOpen === kind) {
        this.closeReasoningPicker();
        return;
      }
      this.closeModelPicker();
      this.closeThemePicker();
      this.closePermissionPicker();
      this.reasoningPickerOpen = kind;
    },
    closeReasoningPicker() { this.reasoningPickerOpen = null; },
    selectReasoningOption(kind, value) {
      if (this.isReasoningPickerOptionDisabled(kind, value)) return;
      this.closeReasoningPicker();
      this.$emit('selectReasoningOption', kind, value);
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
    toggleThemePicker() {
      if (this.themePickerOpen) {
        this.closeThemePicker();
        return;
      }
      this.closeModelPicker();
      this.closeReasoningPicker();
      this.closePermissionPicker();
      this.themePickerOpen = true;
    },
    closeThemePicker() { this.themePickerOpen = false; },
    selectTheme(theme) {
      this.closeThemePicker();
      this.$emit('selectTheme', theme);
    },
    togglePermissionPicker() {
      if (this.permissionPickerOpen) {
        this.closePermissionPicker();
        return;
      }
      if (!this.isConnected || this.pendingPermissionRequestId !== null) return;
      this.closeModelPicker();
      this.closeReasoningPicker();
      this.closeThemePicker();
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
      this.closeModelPicker();
      this.closeReasoningPicker();
      this.closeThemePicker();
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
            <p class="brand-subtitle">Workspace assistant</p>
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
          >×</button>
        </header>

        <section class="section">
          <div class="section-title">
            <h2>Model</h2>
          </div>
          <div class="model-picker" :class="{ open: modelPickerOpen }">
            <button
              class="model-picker-trigger"
              type="button"
              :disabled="!modelCatalog || availableModels.length === 0"
              :aria-expanded="String(modelPickerOpen)"
              aria-haspopup="listbox"
              @click="toggleModelPicker"
            >
                <span class="model-picker-trigger-copy">
                  <span class="model-picker-trigger-name">{{ modelPickerLabel }}</span>
                  <span v-if="selectedModelDetails" class="model-picker-trigger-provider">
                    {{ selectedModelDetails.provider.displayName }}
                  </span>
                </span>
                <span class="model-picker-chevron">⌄</span>
            </button>
            <div v-if="modelPickerOpen" class="model-picker-scrim" @click="closeModelPicker"></div>
            <div
              v-if="modelPickerOpen"
              class="model-picker-panel"
              role="dialog"
              aria-label="Select model"
              @keydown.esc.stop="closeModelPicker"
            >
                <input
                  ref="modelSearchEl"
                  :value="modelSearch"
                  class="model-picker-search"
                  type="search"
                  role="combobox"
                  aria-label="Search models or providers"
                  aria-autocomplete="list"
                  aria-controls="model-picker-options"
                  aria-expanded="true"
                  :aria-activedescendant="activeModelOptionId"
                  placeholder="Search models or providers"
                  @input="onModelSearchInput"
                  @keydown="onModelSearchKeydown"
                />
                <div id="model-picker-options" class="model-picker-list" role="listbox">
                  <div v-if="filteredModelProviders.length === 0" class="model-picker-empty">
                    {{ availableModels.length === 0 ? 'No models available' : 'No matching models' }}
                  </div>
                  <section
                    v-for="provider in filteredModelProviders"
                    :key="provider.providerId"
                    class="model-provider-group"
                  >
                    <div class="model-provider-heading">
                      <span>{{ provider.displayName }}</span>
                    </div>
                    <button
                      v-for="model in provider.models"
                      :key="modelOptionToken(provider.providerId, model.modelId)"
                      class="model-picker-option"
                      :class="{
                        selected: isSelectedModel(provider.providerId, model.modelId),
                        active: activeModelOptionIndex === modelOptionIndex(provider.providerId, model.modelId),
                      }"
                      type="button"
                      role="option"
                      :id="modelOptionId(provider.providerId, model.modelId)"
                      :aria-selected="String(isSelectedModel(provider.providerId, model.modelId))"
                      @mouseenter="activateModelOption(provider.providerId, model.modelId)"
                      @click="selectModel(provider.providerId, model.modelId)"
                    >
                      <span class="model-picker-check">
                        {{ isSelectedModel(provider.providerId, model.modelId) ? '✓' : '' }}
                      </span>
                      <span class="model-picker-option-copy">
                        <span class="model-picker-option-name">{{ model.displayName }}</span>
                      </span>
                      <span
                        v-if="isRuntimeDefaultModel(provider.providerId, model.modelId)"
                        class="model-picker-default-badge"
                      >Default</span>
                    </button>
                  </section>
                </div>
            </div>
          </div>
          <div v-if="showThinkingControl || showEffortControl" class="reasoning-controls">
            <div
              v-if="showThinkingControl"
              class="reasoning-control model-picker"
              :class="{ open: reasoningPickerOpen === 'thinking' }"
            >
              <span class="field-label-text">Thinking</span>
              <button
                class="model-picker-trigger reasoning-picker-trigger"
                type="button"
                :aria-label="`Thinking: ${formatReasoningOption(reasoningSelection.thinking)}`"
                :aria-expanded="String(reasoningPickerOpen === 'thinking')"
                aria-haspopup="listbox"
                @click="toggleReasoningPicker('thinking')"
              >
                <span class="model-picker-trigger-copy">
                  <span class="model-picker-trigger-name">
                    {{ formatReasoningOption(reasoningSelection.thinking) }}
                  </span>
                </span>
                <span class="model-picker-chevron">⌄</span>
              </button>
              <div
                v-if="reasoningPickerOpen === 'thinking'"
                class="model-picker-scrim"
                @click="closeReasoningPicker"
              ></div>
              <div
                v-if="reasoningPickerOpen === 'thinking'"
                class="model-picker-panel reasoning-picker-panel"
                role="listbox"
                aria-label="Thinking options"
                @keydown.esc.stop="closeReasoningPicker"
              >
                <button
                  v-for="value in reasoningPickerOptions('thinking')"
                  :key="value"
                  class="model-picker-option reasoning-picker-option"
                  :class="{ selected: reasoningSelection.thinking === value }"
                  type="button"
                  role="option"
                  :aria-selected="String(reasoningSelection.thinking === value)"
                  :disabled="isReasoningPickerOptionDisabled('thinking', value)"
                  @click="selectReasoningOption('thinking', value)"
                >
                  <span class="model-picker-check">
                    {{ reasoningSelection.thinking === value ? '✓' : '' }}
                  </span>
                  <span class="model-picker-option-copy">
                    <span class="model-picker-option-name">{{ formatReasoningOption(value) }}</span>
                  </span>
                </button>
              </div>
            </div>
            <div
              v-if="showEffortControl"
              class="reasoning-control model-picker"
              :class="{ open: reasoningPickerOpen === 'effort' }"
            >
              <span class="field-label-text">Effort</span>
              <button
                class="model-picker-trigger reasoning-picker-trigger"
                type="button"
                :aria-label="`Reasoning effort: ${formatReasoningOption(reasoningSelection.effort)}`"
                :aria-expanded="String(reasoningPickerOpen === 'effort')"
                aria-haspopup="listbox"
                @click="toggleReasoningPicker('effort')"
              >
                <span class="model-picker-trigger-copy">
                  <span class="model-picker-trigger-name">
                    {{ formatReasoningOption(reasoningSelection.effort) }}
                  </span>
                </span>
                <span class="model-picker-chevron">⌄</span>
              </button>
              <div
                v-if="reasoningPickerOpen === 'effort'"
                class="model-picker-scrim"
                @click="closeReasoningPicker"
              ></div>
              <div
                v-if="reasoningPickerOpen === 'effort'"
                class="model-picker-panel reasoning-picker-panel"
                role="listbox"
                aria-label="Reasoning effort options"
                @keydown.esc.stop="closeReasoningPicker"
              >
                <button
                  v-for="value in reasoningPickerOptions('effort')"
                  :key="value"
                  class="model-picker-option reasoning-picker-option"
                  :class="{ selected: reasoningSelection.effort === value }"
                  type="button"
                  role="option"
                  :aria-selected="String(reasoningSelection.effort === value)"
                  :disabled="isReasoningPickerOptionDisabled('effort', value)"
                  @click="selectReasoningOption('effort', value)"
                >
                  <span class="model-picker-check">
                    {{ reasoningSelection.effort === value ? '✓' : '' }}
                  </span>
                  <span class="model-picker-option-copy">
                    <span class="model-picker-option-name">{{ formatReasoningOption(value) }}</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
          <div v-if="reasoningNotice" class="reasoning-notice" role="status">
            {{ reasoningNotice }}
          </div>
          <div v-if="reasoningConstraintNotice" class="reasoning-notice">
            {{ reasoningConstraintNotice }}
          </div>
        </section>

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
              >＋</button>
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
              >⋯</button>
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
                <span class="session-action-icon" aria-hidden="true">✎</span>
                <span>Rename</span>
              </button>
              <button
                class="session-action-menu-item danger"
                type="button"
                role="menuitem"
                @click="deleteSessionFromMenu"
              >
                <span class="session-action-icon" aria-hidden="true">⌫</span>
                <span>Delete</span>
              </button>
            </div>
          </Teleport>
        </section>

        <section class="section appearance-panel">
          <div class="section-title">
            <h2>Appearance</h2>
          </div>
          <div class="model-picker" :class="{ open: themePickerOpen }">
            <span class="field-label-text">Theme</span>
            <button
              class="model-picker-trigger"
              type="button"
              aria-label="Theme"
              :aria-expanded="String(themePickerOpen)"
              aria-haspopup="listbox"
              @click="toggleThemePicker"
            >
              <span class="model-picker-trigger-copy">
                <span class="model-picker-trigger-name">
                  {{ theme === 'botanical' ? 'Botanical' : 'Classic' }}
                </span>
              </span>
              <span class="model-picker-chevron">⌄</span>
            </button>
            <div
              v-if="themePickerOpen"
              class="model-picker-scrim"
              @click="closeThemePicker"
            ></div>
            <div
              v-if="themePickerOpen"
              class="model-picker-panel"
              role="listbox"
              aria-label="Theme options"
              @keydown.esc.stop="closeThemePicker"
            >
              <button
                class="model-picker-option"
                :class="{ selected: theme === 'classic' }"
                type="button"
                role="option"
                :aria-selected="String(theme === 'classic')"
                @click="selectTheme('classic')"
              >
                <span class="model-picker-check">{{ theme === 'classic' ? '✓' : '' }}</span>
                <span class="model-picker-option-copy">
                  <span class="model-picker-option-name">Classic</span>
                </span>
              </button>
              <button
                class="model-picker-option"
                :class="{ selected: theme === 'botanical' }"
                type="button"
                role="option"
                :aria-selected="String(theme === 'botanical')"
                @click="selectTheme('botanical')"
              >
                <span class="model-picker-check">{{ theme === 'botanical' ? '✓' : '' }}</span>
                <span class="model-picker-option-copy">
                  <span class="model-picker-option-name">Botanical</span>
                </span>
              </button>
            </div>
          </div>
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
              <span class="model-picker-chevron">⌄</span>
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
                <span class="model-picker-check">{{ permissionMode === 'manual' ? '✓' : '' }}</span>
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
                <span class="model-picker-check">{{ permissionMode === 'allow_all' ? '✓' : '' }}</span>
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
