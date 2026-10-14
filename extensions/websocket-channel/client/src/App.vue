<script>
import { defineComponent } from 'vue';

import {
  ATTACHMENT_INLINE_THRESHOLD_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  readFileAsBase64,
  validateAttachmentSelection,
} from './attachments';
import {
  appendConversationItem,
  applyAgentEvent,
  markApprovalClosed as applyApprovalClosed,
  resolveEventSessionId,
  syncApprovalCards as syncConversationApprovalCards,
} from './client/conversation';
import {
  applyHistoryPage,
  beginHistoryRequest,
  failHistoryRequest,
  historyRetryOptions,
  interruptHistoryRequest,
  mergeRealtimeWithHistory,
} from './client/history';
import { parseServerMessage } from './client/protocol';
import { configuredWebSocketUrl, SocketClient } from './client/socket';
import {
  createSessionUiState,
  ensureSessionUiState,
} from './client/session-state';
import {
  currentTheme,
  selectTheme as persistTheme,
} from './client/theme';
import ComposerPanel from './components/ComposerPanel.vue';
import ConversationPanel from './components/ConversationPanel.vue';
import ChildDetailPanel from './components/ChildDetailPanel.vue';
import SidebarPanel from './components/SidebarPanel.vue';

const CLIENT_SOCKET_URL = configuredWebSocketUrl();
const MAX_EVENT_FEED_ITEMS = 40;
const THINKING_OPTION_ORDER = Object.freeze(['on', 'off']);
const EFFORT_OPTION_ORDER = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function createClientId() {
  return `browser-${Math.random().toString(36).slice(2, 8)}`;
}

      export default defineComponent({
        components: {
          ComposerPanel,
          ConversationPanel,
          ChildDetailPanel,
          SidebarPanel,
        },
        data() {
          return {
            form: {
              clientId: createClientId(),
              sessionId: '',
            },
            transport: null,
            connectionStatus: 'disconnected',
            helloAcknowledged: false,
            modelCatalog: null,
            pendingCatalogRequestId: null,
            nextCatalogRequestId: 1,
            pendingSessionRequestId: null,
            nextSessionRequestId: 1,
            pendingFirstTurn: null,
            focusedSessionSubscribed: false,
            pendingSessionSubscription: null,
            openedChildSessionId: '',
            childSubscriptionStatus: 'closed',
            childUnavailable: false,
            childPendingAction: null,
            nextSessionSubscriptionRequestId: 1,
            nextPermissionRequestId: 1,
            sessions: [],
            pendingSessionsRequestId: null,
            nextSessionsRequestId: 1,
            pendingApprovals: new Map(),
            pendingApprovalsRequestId: null,
            nextApprovalsRequestId: 1,
            refreshTimer: null,
            sessionsRequestTimer: null,
            approvalsRequestTimer: null,
            pendingSessionOperation: null,
            nextSessionOperationRequestId: 1,
            nextHistoryRequestId: 1,
            sessionsError: '',
            modelSelection: null,
            modelSelectionSource: 'none',
            reasoningSelection: {
              thinking: 'default',
              effort: 'default',
            },
            reasoningNotice: '',
            theme: currentTheme(),
            sessionStates: { '': createSessionUiState() },
            nextId: 1,
            eventFeed: [],
            nextEventId: 1,
            lastStatusMessage: 'Not connected.',
          };
        },
        mounted() {
          this.transport = new SocketClient(CLIENT_SOCKET_URL, {
            onStatusChange: status => { this.connectionStatus = status; },
            onConnecting: (url, isRetry) => {
              this.clearTransientState();
              this.lastStatusMessage = isRetry
                ? 'Reconnecting to agent…'
                : 'Connecting to agent…';
              this.pushEvent('socket', `Connecting to ${url}`);
            },
            onOpen: () => {
              this.lastStatusMessage = 'Socket opened. Sending hello…';
              this.sendJson({ type: 'hello', clientId: this.form.clientId });
            },
            onMessage: data => { this.handleServerMessage(data); },
            onClose: detail => {
              this.clearTransientState();
              this.lastStatusMessage = detail;
              this.pushEvent('close', detail);
            },
            onError: detail => {
              this.lastStatusMessage = detail === 'WebSocket transport error'
                ? 'WebSocket error.'
                : detail;
              this.pushEvent('error', detail);
            },
            onReconnectScheduled: delay => {
              this.lastStatusMessage = `Connection lost. Retrying in ${Math.ceil(delay / 1000)}s…`;
            },
          });
          this.transport.start();
        },
        beforeUnmount() {
          this.stopConnection();
        },
        computed: {
          activeSessionState() {
            return this.ensureSessionState(this.form.sessionId);
          },
          draft: {
            get() { return this.activeSessionState.draft; },
            set(value) { this.activeSessionState.draft = value; },
          },
          chatItems: {
            get() { return this.activeSessionState.chatItems; },
            set(value) { this.activeSessionState.chatItems = value; },
          },
          displayedChatItems() {
            const items = mergeRealtimeWithHistory(this.activeSessionState.historyItems, this.chatItems);
            for (const request of this.pendingApprovals.values()) {
              if (request.sessionId !== this.form.sessionId || items.some(item =>
                item.turnId === request.turnId && item.segments?.some(seg =>
                  seg.type === 'tool_call' && seg.callId === request.callId))) continue;
              items.push({
                kind: 'turn', id: `pending-${request.id}`, turnId: request.turnId,
                label: 'Assistant', timestamp: Date.now(),
                segments: [{
                  type: 'tool_call', id: `pending-${request.id}`, callId: request.callId,
                  name: request.toolName, input: request.input, status: 'approval',
                  approval: { ...request, status: 'pending' }, expanded: true,
                }],
              });
            }
            return items;
          },
          childSessionState() {
            return this.openedChildSessionId
              ? this.ensureSessionState(this.openedChildSessionId)
              : null;
          },
          childDisplayedItems() {
            if (!this.childSessionState) return [];
            return mergeRealtimeWithHistory(
              this.childSessionState.historyItems,
              this.childSessionState.chatItems,
            );
          },
          historyStatus() { return this.activeSessionState.historyStatus; },
          historyError() { return this.activeSessionState.historyError; },
          historyHasMore() { return this.activeSessionState.historyHasMore; },
          turnMap: {
            get() { return this.activeSessionState.turnMap; },
            set(value) { this.activeSessionState.turnMap = value; },
          },
          isWaitingForReply() { return this.activeSessionState.activeTurnId !== null; },
          permissionMode: {
            get() { return this.activeSessionState.permissionMode; },
            set(value) { this.activeSessionState.permissionMode = value; },
          },
          permissionChangedAt: {
            get() { return this.activeSessionState.permissionChangedAt; },
            set(value) { this.activeSessionState.permissionChangedAt = value; },
          },
          pendingPermissionRequestId: {
            get() { return this.activeSessionState.pendingPermissionRequestId; },
            set(value) { this.activeSessionState.pendingPermissionRequestId = value; },
          },
          attachments: {
            get() { return this.activeSessionState.attachments; },
            set(value) { this.activeSessionState.attachments = value; },
          },
          attachError: {
            get() { return this.activeSessionState.attachError; },
            set(value) { this.activeSessionState.attachError = value; },
          },
          isConnected() { return this.connectionStatus === 'connected'; },
          isConnecting() {
            return this.connectionStatus === 'connecting' || this.connectionStatus === 'reconnecting';
          },
          canSend() {
            if (!this.isConnected || !this.helloAcknowledged) return false;
            if (this.form.sessionId && !this.focusedSessionSubscribed) return false;
            if (!this.modelSelectionValid) return false;
            if (!this.reasoningSelectionValid) return false;
            if (this.pendingSessionRequestId !== null) return false;
            if (this.pendingSessionSubscription !== null) return false;
            if (this.activeSessionState.isSending) return false;
            if (this.pendingApprovalCount > 0) return false;
            if (this.attachError) return false;
            if (this.isWaitingForReply && this.attachments.length > 0) return false;
            if (!this.selectedModelSupportsImages && this.attachments.length > 0) return false;
            const hasText = this.draft.trim().length > 0;
            const hasAttachments = this.attachments.length > 0;
            return hasText || hasAttachments;
          },
          statusClass() {
            if (this.connectionStatus === 'connected') return 'connected';
            if (this.connectionStatus === 'connecting' || this.connectionStatus === 'reconnecting') {
              return 'connecting';
            }
            return 'disconnected';
          },
          connectionStatusLabel() {
            if (this.connectionStatus === 'connected') return 'Online';
            if (this.connectionStatus === 'reconnecting') return 'Retrying';
            if (this.connectionStatus === 'connecting') return 'Connecting';
            return 'Offline';
          },
          currentSession() {
            return this.sessions.find(session => session.sessionId === this.form.sessionId) ?? null;
          },
          currentSessionLabel() {
            if (!this.form.sessionId) return 'New Session';
            return this.currentSession?.title || `Session ${this.shortSessionId(this.form.sessionId)}`;
          },
          availableModelProviders() {
            return (this.modelCatalog?.providers ?? []).filter(
              provider => provider
                && Array.isArray(provider.models)
                && provider.models.length > 0,
            );
          },
          availableModels() {
            return this.availableModelProviders.flatMap(provider => provider.models.map(model => ({
              provider,
              model,
              reference: {
                providerId: provider.providerId,
                modelId: model.modelId,
              },
            })));
          },
          selectedModelReference() {
            if (!this.modelSelection) return null;
            return this.availableModels.some(({ reference }) => this.sameModelReference(
              reference,
              this.modelSelection,
            )) ? this.modelSelection : null;
          },
          selectedModelDetails() {
            if (!this.selectedModelReference) return null;
            return this.availableModels.find(({ reference }) => this.sameModelReference(
              reference,
              this.selectedModelReference,
            )) ?? null;
          },
          selectedModelSupportsImages() {
            const mediaKinds = this.selectedModelDetails?.model?.capabilities?.mediaKinds;
            return !Array.isArray(mediaKinds) || mediaKinds.includes('image');
          },
          thinkingOptions() {
            const declared = this.selectedModelDetails?.model?.capabilities?.reasoning?.thinking;
            if (!Array.isArray(declared)) return [];
            return THINKING_OPTION_ORDER.filter(value => declared.includes(value));
          },
          effortOptions() {
            const declared = this.selectedModelDetails?.model?.capabilities?.reasoning?.efforts;
            if (!Array.isArray(declared)) return [];
            return EFFORT_OPTION_ORDER.filter(value => declared.includes(value));
          },
          showThinkingControl() {
            return this.thinkingOptions.length > 0;
          },
          showEffortControl() {
            return this.effortOptions.length > 0;
          },
          reasoningSelectionValid() {
            const thinking = this.reasoningSelection.thinking;
            const effort = this.reasoningSelection.effort;
            if (thinking !== 'default' && !this.thinkingOptions.includes(thinking)) return false;
            if (effort !== 'default' && !this.effortOptions.includes(effort)) return false;
            if (thinking === 'on' && effort === 'none') return false;
            return thinking !== 'off'
              || effort === 'default'
              || effort === 'none';
          },
          reasoningConstraintNotice() {
            if (this.reasoningSelection.effort === 'none') {
              return 'Thinking On is unavailable while Effort is None.';
            }
            if (this.reasoningSelection.thinking === 'off') {
              return 'Choose Default or None effort while Thinking is Off.';
            }
            return '';
          },
          attachmentCapabilityExplanation() {
            if (!this.selectedModelSupportsImages) {
              return 'The selected model explicitly does not support image attachments.';
            }
            const mediaKinds = this.selectedModelDetails?.model?.capabilities?.mediaKinds;
            return Array.isArray(mediaKinds)
              ? 'Add images'
              : 'Add images (model capability is unknown; the server will validate the request)';
          },
          requestModelReference() {
            if (this.modelSelectionSource === 'default') return null;
            return this.selectedModelReference;
          },
          modelSelectionValid() {
            return this.selectedModelReference !== null;
          },
          modelPickerLabel() {
            if (!this.modelCatalog) return 'Loading models…';
            return this.selectedModelDetails?.model.displayName ?? 'No models available';
          },
          pendingApprovalCount() {
            return [...this.pendingApprovals.values()]
              .filter(request => request.sessionId === this.form.sessionId).length;
          },
          maxAttachmentsPerMessage() { return MAX_ATTACHMENTS_PER_MESSAGE; },
        },

        methods: {
          ensureSessionState(sessionId) {
            return ensureSessionUiState(this.sessionStates, sessionId);
          },
          // ── Connection ────────────────────────────────────────
          clearTransientState() {
            this.stopSessionRefresh();
            this.helloAcknowledged = false;
            this.modelCatalog = null;
            this.pendingCatalogRequestId = null;
            this.pendingSessionRequestId = null;
            this.pendingFirstTurn = null;
            this.focusedSessionSubscribed = false;
            this.pendingSessionSubscription = null;
            this.childSubscriptionStatus = this.openedChildSessionId
              ? 'disconnected'
              : 'closed';
            this.childUnavailable = false;
            this.childPendingAction = null;
            this.pendingSessionsRequestId = null;
            this.pendingSessionOperation = null;
            this.closeSidebarTransientUi();
            this.clearModelSelection();
            for (const state of Object.values(this.sessionStates)) {
              state.permissionMode = 'manual';
              state.permissionChangedAt = 0;
              state.pendingPermissionRequestId = null;
              state.isSending = false;
              state.activeTurnId = null;
              interruptHistoryRequest(state);
            }
          },
          stopConnection() {
            this.stopSessionRefresh();
            this.transport?.stop();
          },

          // ── Sending ───────────────────────────────────────────
          sendJson(payload) {
            if (!this.transport) throw new Error('Socket Client is not initialized.');
            this.transport.sendJson(payload);
          },
          requestModelCatalog() {
            if (this.pendingCatalogRequestId !== null) return;
            const requestId = `catalog-${this.nextCatalogRequestId++}`;
            this.pendingCatalogRequestId = requestId;
            this.sendJson({ type: 'get_model_catalog', requestId });
          },
          requestSessionList() {
            if (!this.isConnected || this.pendingSessionsRequestId !== null) return;
            const requestId = `sessions-${this.nextSessionsRequestId++}`;
            this.pendingSessionsRequestId = requestId;
            this.sessionsRequestTimer = window.setTimeout(() => {
              if (this.pendingSessionsRequestId !== requestId) return;
              this.finishSessionListRequest();
              this.sessionsError = 'Session list refresh timed out.';
              this.pushEvent('error', this.sessionsError);
            }, 8000);
            try {
              this.sendJson({ type: 'list_sessions', requestId });
            } catch (error) {
              this.finishSessionListRequest();
              this.sessionsError = String(error.message ?? error);
              this.pushEvent('error', this.sessionsError);
            }
          },
          finishSessionListRequest() {
            window.clearTimeout(this.sessionsRequestTimer);
            this.sessionsRequestTimer = null;
            this.pendingSessionsRequestId = null;
          },
          finishApprovalsRequest() {
            window.clearTimeout(this.approvalsRequestTimer);
            this.approvalsRequestTimer = null;
            this.pendingApprovalsRequestId = null;
          },
          requestSessionSubscription(
            type,
            sessionId,
            targetSessionId = sessionId,
            owner = 'parent',
          ) {
            if (!this.isConnected || !sessionId || this.pendingSessionSubscription !== null) {
              return false;
            }
            const requestId = `subscription-${this.nextSessionSubscriptionRequestId++}`;
            this.pendingSessionSubscription = {
              type,
              requestId,
              sessionId,
              targetSessionId,
              owner,
            };
            try {
              this.sendJson({ type, requestId, sessionId });
              return true;
            } catch (error) {
              this.pendingSessionSubscription = null;
              this.pushEvent('subscription_error', String(error.message ?? error));
              return false;
            }
          },
          activateFocusedSession(sessionId) {
            this.form.sessionId = sessionId;
            this.focusedSessionSubscribed = false;
            this.ensureSessionState(sessionId);
            if (!sessionId) {
              this.$refs.sidebarPanel?.closeMobileSidebar();
              return;
            }
            this.scrollChatToBottom(sessionId, { force: true });
            this.pushEvent('session_selected', `Selected Session ${sessionId}`);
            if (!this.isConnected) {
              this.$refs.sidebarPanel?.closeMobileSidebar();
              return;
            }
            if (!this.requestSessionSubscription('subscribe_session', sessionId)) {
              this.$refs.sidebarPanel?.closeMobileSidebar();
            }
          },
          switchFocusedSession(sessionId) {
            if (this.pendingSessionSubscription?.owner === 'parent') return;
            const previousSessionId = this.form.sessionId;
            if (previousSessionId === sessionId) {
              this.$refs.sidebarPanel?.closeMobileSidebar();
              return;
            }
            if (this.openedChildSessionId) {
              this.beginChildTransition({ type: 'switch-parent', targetSessionId: sessionId });
              return;
            }
            if (
              previousSessionId
              && this.isConnected
              && this.requestSessionSubscription(
                'unsubscribe_session',
                previousSessionId,
                sessionId,
              )
            ) {
              return;
            }
            this.activateFocusedSession(sessionId);
          },
          activateChildDetail(sessionId) {
            this.openedChildSessionId = sessionId;
            this.childUnavailable = false;
            this.ensureSessionState(sessionId);
            if (!this.isConnected) {
              this.childSubscriptionStatus = 'disconnected';
              return;
            }
            this.childSubscriptionStatus = 'subscribing';
            if (!this.requestSessionSubscription(
              'subscribe_session',
              sessionId,
              sessionId,
              'child',
            )) {
              this.childSubscriptionStatus = 'disconnected';
            }
          },
          openChildDetail(sessionId) {
            if (!sessionId || this.pendingSessionSubscription?.owner === 'parent') return;
            if (sessionId === this.openedChildSessionId) {
              if (this.childUnavailable && this.pendingSessionSubscription === null) {
                this.activateChildDetail(sessionId);
              }
              return;
            }
            if (this.openedChildSessionId) {
              this.beginChildTransition({ type: 'replace', targetSessionId: sessionId });
              return;
            }
            this.activateChildDetail(sessionId);
          },
          closeChildDetail() {
            if (!this.openedChildSessionId) return;
            this.beginChildTransition({ type: 'close' });
          },
          beginChildTransition(action) {
            if (!this.openedChildSessionId) {
              this.completeChildTransition(action);
              return;
            }
            this.childPendingAction = action;
            const pending = this.pendingSessionSubscription;
            if (pending?.owner === 'child') return;
            if (this.childSubscriptionStatus !== 'subscribed' || !this.isConnected) {
              this.completeChildTransition(action);
              return;
            }
            this.childSubscriptionStatus = 'unsubscribing';
            if (!this.requestSessionSubscription(
              'unsubscribe_session',
              this.openedChildSessionId,
              this.openedChildSessionId,
              'child',
            )) {
              this.childSubscriptionStatus = 'subscribed';
            }
          },
          completeChildTransition(action = this.childPendingAction) {
            this.childPendingAction = null;
            this.childSubscriptionStatus = 'closed';
            this.childUnavailable = false;
            this.openedChildSessionId = '';
            if (action?.type === 'replace') {
              this.activateChildDetail(action.targetSessionId);
            } else if (action?.type === 'switch-parent') {
              this.switchFocusedSession(action.targetSessionId);
            }
          },
          requestPendingApprovals() {
            if (!this.isConnected || this.pendingApprovalsRequestId !== null) return;
            const requestId = `approvals-${this.nextApprovalsRequestId++}`;
            this.pendingApprovalsRequestId = requestId;
            this.approvalsRequestTimer = window.setTimeout(() => {
              if (this.pendingApprovalsRequestId !== requestId) return;
              this.finishApprovalsRequest();
              this.pushEvent('error', 'Pending Approval refresh timed out.');
            }, 8000);
            try {
              this.sendJson({ type: 'get_session_approvals', requestId });
            } catch (error) {
              this.finishApprovalsRequest();
              this.pushEvent('error', String(error.message ?? error));
            }
          },
          startSessionRefresh() {
            this.stopSessionRefresh();
            const refresh = () => {
              this.requestSessionList();
              this.requestPendingApprovals();
            };
            refresh();
            this.refreshTimer = window.setInterval(refresh, 10000);
          },
          stopSessionRefresh() {
            window.clearInterval(this.refreshTimer);
            this.refreshTimer = null;
            this.finishSessionListRequest();
            this.finishApprovalsRequest();
          },
          hasSessionApprovals(sessionId) {
            return [...this.pendingApprovals.values()].some(request => request.sessionId === sessionId);
          },
          validApproval(request) {
            return ['id', 'sessionId', 'turnId', 'callId', 'toolName']
              .every(key => typeof request?.[key] === 'string' && request[key].length > 0)
              && request.input !== null && typeof request.input === 'object';
          },
          syncApprovalCards() {
            syncConversationApprovalCards(this.sessionStates, this.pendingApprovals);
          },
          requestSessionHistory(sessionId, options = {}) {
            if (!this.isConnected || !sessionId) return;
            const state = this.ensureSessionState(sessionId);
            const requestId = state.pendingHistoryRequest
              ? ''
              : `history-${this.nextHistoryRequestId++}`;
            const request = beginHistoryRequest(state, requestId, options);
            if (!request) return;
            this.sendJson({
              type: 'get_session_history',
              requestId: request.requestId,
              sessionId,
              ...(request.beforeEntryId ? { beforeEntryId: request.beforeEntryId } : {}),
              limit: 50,
            });
          },
          loadEarlierHistory() {
            const state = this.activeSessionState;
            if (!state.historyHasMore || !state.historyNextCursor) return;
            this.requestSessionHistory(this.form.sessionId, {
              beforeEntryId: state.historyNextCursor,
            });
          },
          retryHistory() {
            const options = historyRetryOptions(this.activeSessionState);
            if (options) this.requestSessionHistory(this.form.sessionId, options);
          },
          loadEarlierChildHistory() {
            const state = this.childSessionState;
            if (!state?.historyHasMore || !state.historyNextCursor) return;
            this.requestSessionHistory(this.openedChildSessionId, {
              beforeEntryId: state.historyNextCursor,
            });
          },
          retryChildHistory() {
            if (!this.childSessionState) return;
            const options = historyRetryOptions(this.childSessionState);
            if (options) this.requestSessionHistory(this.openedChildSessionId, options);
          },
          openMobileSidebar() {
            this.$refs.sidebarPanel?.openMobileSidebar();
          },
          closeSidebarTransientUi() {
            this.$refs.sidebarPanel?.closeTransientUi();
          },
          beginSessionOperation(type, sessionId, payload = {}) {
            if (!this.isConnected || this.pendingSessionOperation !== null) return;
            const requestId = `session-${type}-${this.nextSessionOperationRequestId++}`;
            this.pendingSessionOperation = { type, requestId, sessionId };
            this.sessionsError = '';
            try {
              this.sendJson({
                type: `${type}_session`,
                requestId,
                sessionId,
                ...payload,
              });
            } catch (error) {
              this.pendingSessionOperation = null;
              this.sessionsError = error instanceof Error ? error.message : String(error);
              this.pushEvent('error', `Failed to ${type} Session ${sessionId}`);
            }
          },
          renameSessionFromMenu(session) {
            if (!session?.sessionId) return;
            const title = window.prompt(
              'Rename Session\n\nLeave blank to clear the custom name.',
              session.title || '',
            );
            if (title === null) return;
            const normalizedTitle = title.trim();
            this.beginSessionOperation(
              'rename',
              session.sessionId,
              { title: normalizedTitle || null },
            );
          },
          deleteSessionFromMenu(session) {
            if (!session?.sessionId) return;
            const label = session.title || this.shortSessionId(session.sessionId);
            if (!window.confirm(
              `Delete Session "${label}"?\n\n`
                + 'Its conversation history will be permanently removed. This cannot be undone.',
            )) {
              return;
            }
            this.beginSessionOperation('delete', session.sessionId);
          },
          upsertSession(session) {
            if (!session?.sessionId) return;
            const existingIndex = this.sessions.findIndex(
              entry => entry.sessionId === session.sessionId,
            );
            const next = [...this.sessions];
            if (existingIndex >= 0) next.splice(existingIndex, 1, session);
            else next.push(session);
            next.sort((left, right) =>
              (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0)
                || String(left.sessionId).localeCompare(String(right.sessionId)));
            this.sessions = next;
          },
          requestPermissionMode() {
            if (!this.isConnected || !this.form.sessionId || this.pendingPermissionRequestId !== null) return;
            const requestId = `permission-${this.nextPermissionRequestId++}`;
            this.pendingPermissionRequestId = requestId;
            this.sendJson({
              type: 'get_session_permission_mode',
              sessionId: this.form.sessionId,
            });
          },
          changePermissionMode(mode) {
            if (mode !== 'manual' && mode !== 'allow_all') return;
            if (mode === this.permissionMode) return;
            if (mode === 'allow_all' && !window.confirm(
              'Allow all tools for this Session?\n\n'
                + 'Every non-denied tool will run without asking. Arbitrary Shell commands and '
                + 'external filesystem changes are possible. Executable and dependency integrity '
                + 'is not verified. This mode remains active after disconnect and ends only when '
                + 'you revoke it, archive/delete the Session, or restart the Runtime.',
            )) {
              return;
            }
            if (!this.form.sessionId) {
              this.permissionMode = mode;
              return;
            }
            const requestId = `permission-${this.nextPermissionRequestId++}`;
            this.pendingPermissionRequestId = requestId;
            this.sendJson({
              type: 'set_session_permission_mode',
              sessionId: this.form.sessionId,
              mode,
            });
          },
          selectPermissionMode(mode) {
            this.changePermissionMode(mode);
          },
          selectTheme(theme) {
            persistTheme(theme);
            this.theme = theme;
          },
          reasoningPickerOptions(kind) {
            return [
              'default',
              ...(kind === 'thinking' ? this.thinkingOptions : this.effortOptions),
            ];
          },
          isReasoningPickerOptionDisabled(kind, value) {
            if (value === 'default') return false;
            return kind === 'thinking'
              ? this.isThinkingOptionDisabled(value)
              : this.isEffortOptionDisabled(value);
          },
          selectReasoningOption(kind, value) {
            if (this.isReasoningPickerOptionDisabled(kind, value)) return;
            this.reasoningSelection[kind] = value;
          },
          selectModel(providerId, modelId) {
            const reference = Object.freeze({ providerId, modelId });
            this.modelSelection = reference;
            this.modelSelectionSource = 'user';
            this.reconcileReasoningSelection();
          },
          clearModelSelection() {
            this.modelSelection = null;
            this.modelSelectionSource = 'none';
            this.reasoningSelection.thinking = 'default';
            this.reasoningSelection.effort = 'default';
            this.reasoningNotice = '';
            this.closeSidebarTransientUi();
          },
          sameModelReference(left, right) {
            return left !== null
              && left !== undefined
              && right !== null
              && right !== undefined
              && left.providerId === right.providerId
              && left.modelId === right.modelId;
          },
          modelOptionToken(providerId, modelId) {
            return JSON.stringify([providerId, modelId]);
          },
          isSelectedModel(providerId, modelId) {
            return this.sameModelReference(
              { providerId, modelId },
              this.selectedModelReference,
            );
          },
          isRuntimeDefaultModel(providerId, modelId) {
            return this.sameModelReference(
              { providerId, modelId },
              this.availableRuntimeDefault(this.modelCatalog),
            );
          },
          catalogHasModel(catalog, reference) {
            if (!reference || !Array.isArray(catalog?.providers)) return false;
            return catalog.providers.some(provider =>
              provider?.providerId === reference.providerId
              && Array.isArray(provider.models)
              && provider.models.some(model => model?.modelId === reference.modelId));
          },
          availableRuntimeDefault(catalog) {
            const selection = catalog?.defaultSelection;
            if (selection?.state !== 'available' || !selection.reference) return null;
            return this.catalogHasModel(catalog, selection.reference)
              ? {
                  providerId: selection.reference.providerId,
                  modelId: selection.reference.modelId,
                }
              : null;
          },
          firstAvailableModel(catalog) {
            if (!Array.isArray(catalog?.providers)) return null;
            for (const provider of catalog.providers) {
              if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) {
                continue;
              }
              const model = provider.models[0];
              if (model) {
                return { providerId: provider.providerId, modelId: model.modelId };
              }
            }
            return null;
          },
          applyModelCatalog(catalog) {
            if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.providers)) {
              this.pushEvent('model_catalog', 'Ignored malformed Model Catalog response');
              return;
            }
            const previousSelection = this.modelSelection
              ? { ...this.modelSelection }
              : null;
            const preserveUserSelection = this.modelSelectionSource === 'user'
              && this.catalogHasModel(catalog, previousSelection);
            this.modelCatalog = catalog;
            if (preserveUserSelection) {
              this.modelSelection = Object.freeze(previousSelection);
              this.modelSelectionSource = 'user';
            } else {
              const runtimeDefault = this.availableRuntimeDefault(catalog);
              const fallback = this.firstAvailableModel(catalog);
              if (runtimeDefault) {
                this.modelSelection = Object.freeze(runtimeDefault);
                this.modelSelectionSource = 'default';
              } else if (fallback) {
                this.modelSelection = Object.freeze(fallback);
                this.modelSelectionSource = 'fallback';
              } else {
                this.clearModelSelection();
              }
            }
            this.reconcileReasoningSelection();
            this.closeSidebarTransientUi();
            this.pushEvent(
              'model_catalog',
              `Loaded generation ${catalog.generation} with ${catalog.providers.length} provider(s)`,
            );
          },
          sendMessage() {
            if (!this.canSend) return;
            const text = this.draft.trim();
            const isSteer = this.isWaitingForReply;
            const hasAttachments = this.attachments.length > 0;

            let wireMessage;
            if (!hasAttachments) {
              wireMessage = text;
            } else {
              const blocks = [];
              if (text) blocks.push({ type: 'text', text });
              for (const a of this.attachments) {
                blocks.push({
                  type: 'image',
                  source: { type: 'base64', mediaType: a.mediaType, data: a.base64 },
                });
              }
              wireMessage = blocks;
            }

            this.appendChatItem({
              kind: 'user',
              label: 'You',
              text,
              isSteer,
              reasoning: this.currentReasoningPreference(),
              attachments: hasAttachments
                ? this.attachments.map(a => ({
                    id: a.id,
                    previewUrl: a.previewUrl,
                    name: a.name,
                    sizeBytes: a.sizeBytes,
                    willResize: a.willResize,
                  }))
                : [],
            }, this.form.sessionId, { forceScroll: true });

            const pendingTurn = {
              message: wireMessage,
              modelReference: this.requestModelReference,
              reasoning: this.currentReasoningPreference(),
              isSteer,
              attachmentCount: this.attachments.length,
            };
            if (this.form.sessionId) {
              this.dispatchRunTurn(pendingTurn);
            } else {
              // A new Session is local empty-ID state until the first message requests an ID.
              const requestId = `session-${this.nextSessionRequestId++}`;
              this.pendingSessionRequestId = requestId;
              this.pendingFirstTurn = pendingTurn;
              this.sendJson({
                type: 'create_session',
                requestId,
                permissionMode: this.permissionMode,
              });
              this.pushEvent('create_session', 'Requested a Session for the first message');
            }
            this.draft = '';
            // Do NOT revoke previewUrl here — the bubble still references it.
            this.attachments = [];
            this.attachError = '';
          },

          dispatchRunTurn(turn) {
            const state = this.activeSessionState;
            state.isSending = true;
            try {
              this.sendJson({
                type: 'run_turn',
                sessionId: this.form.sessionId,
                message: turn.message,
                ...(turn.modelReference ? { modelReference: turn.modelReference } : {}),
                reasoning: turn.reasoning,
              });
            } catch (error) {
              state.isSending = false;
              this.pushEvent('send_error', error.message);
              this.appendChatItem({ kind: 'error', label: 'Channel', text: error.message });
              throw error;
            }
            this.pushEvent(
              turn.isSteer ? 'steer' : 'run_turn',
              `Sent ${turn.isSteer ? 'steer ' : ''}message to session ${this.form.sessionId}`
                + (turn.attachmentCount ? ` (${turn.attachmentCount} attachment${turn.attachmentCount !== 1 ? 's' : ''})` : ''),
            );
          },

          // ── Attachments ───────────────────────────────────────
          async ingestFiles(fileList) {
            const incoming = Array.from(fileList ?? []);
            if (incoming.length === 0) return;
            const state = this.activeSessionState;
            if (!this.selectedModelSupportsImages) {
              state.attachError = this.attachmentCapabilityExplanation;
              return;
            }
            const errors = validateAttachmentSelection(state.attachments, incoming);
            if (errors.length > 0) {
              state.attachError = `${errors.join('; ')}. No files from this selection were added.`;
              return;
            }

            try {
              const encoded = await Promise.all(incoming.map(async file => ({
                file,
                base64: await readFileAsBase64(file),
              })));
              if (!this.selectedModelSupportsImages) {
                state.attachError = this.attachmentCapabilityExplanation;
                return;
              }
              const commitErrors = validateAttachmentSelection(state.attachments, incoming);
              if (commitErrors.length > 0) {
                state.attachError = `${commitErrors.join('; ')}. No files from this selection were added.`;
                return;
              }
              const prepared = encoded.map(({ file, base64 }) => ({
                  id: this.nextId++,
                  file,
                  name: file.name,
                  mediaType: file.type,
                  sizeBytes: file.size,
                  base64,
                  willResize: file.size > ATTACHMENT_INLINE_THRESHOLD_BYTES,
                  previewUrl: URL.createObjectURL(file),
                }));
              state.attachments.push(...prepared);
              state.attachError = '';
            } catch (err) {
              state.attachError = `Failed to read the selected files (${err?.message || err}). No files were added.`;
            }
          },
          removeAttachment(id) {
            const idx = this.attachments.findIndex(a => a.id === id);
            if (idx >= 0) {
              URL.revokeObjectURL(this.attachments[idx].previewUrl);
              this.attachments.splice(idx, 1);
            }
          },
          clearAttachments() {
            for (const a of this.attachments) URL.revokeObjectURL(a.previewUrl);
            this.attachments = [];
          },
          resetComposer() {
            this.draft = '';
            this.clearAttachments();
            this.attachError = '';
          },

          // Send inbound `abort_turn`; server-side stops the current turn
          // and drops queued/followup messages for this session
          // (core-abort-spec.md §8.3 / §13). No inline ack — completion
          // is observed via run_end{stopReason:'aborted'} (special-cased
          // below in handleServerMessage's run_end branch).
          abortTurn() {
            if (!this.isConnected || !this.form.sessionId) return;
            try {
              this.sendJson({ type: 'abort_turn', sessionId: this.form.sessionId });
              this.pushEvent('abort_turn', `Sent abort_turn for session ${this.form.sessionId}`);
            } catch (err) {
              this.pushEvent('error', `Failed to send abort_turn: ${err?.message ?? err}`);
            }
          },
          resolveApproval(seg, decision) {
            if (!this.isConnected || !seg?.approval || seg.approval.status !== 'pending'
              || !this.pendingApprovals.has(seg.approval.id)) return;
            this.sendJson({ type: 'approval_resolve', id: seg.approval.id, decision });
            this.pushEvent('approval', `${decision === 'allow' ? 'Allowed' : 'Denied'} ${seg.approval.toolName}`);
          },

          // ── Message handling ──────────────────────────────────
          handleServerMessage(raw) {
            const parsed = parseServerMessage(raw);
            if (!parsed.ok && parsed.reason === 'invalid_json') {
              this.pushEvent('parse', `Received non-JSON payload: ${String(raw).slice(0, 120)}`);
              return;
            }
            if (!parsed.ok) {
              this.pushEvent('parse', 'Ignored non-object server payload');
              return;
            }
            const message = parsed.message;
            switch (message.type) {
              case 'hello_ack':
                this.transport?.markConnected();
                this.helloAcknowledged = true;
                this.lastStatusMessage = `Hello acknowledged as ${message.clientId}`;
                this.pushEvent('hello', `Server acknowledged client ${message.clientId}`);
                this.requestModelCatalog();
                this.startSessionRefresh();
                if (this.form.sessionId) {
                  this.requestSessionSubscription('subscribe_session', this.form.sessionId);
                } else if (this.openedChildSessionId) {
                  this.activateChildDetail(this.openedChildSessionId);
                }
                return;
              case 'model_catalog':
                if (message.requestId !== this.pendingCatalogRequestId) {
                  this.pushEvent('model_catalog', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.pendingCatalogRequestId = null;
                this.applyModelCatalog(message.catalog);
                return;
              case 'session_created': {
                if (message.requestId !== this.pendingSessionRequestId || !this.pendingFirstTurn) {
                  this.pushEvent('session_created', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                const pendingTurn = this.pendingFirstTurn;
                this.pendingSessionRequestId = null;
                this.pendingFirstTurn = null;
                this.sessionStates[message.sessionId] = this.ensureSessionState('');
                delete this.sessionStates[''];
                this.form.sessionId = message.sessionId;
                this.focusedSessionSubscribed = true;
                if (message.permission?.sessionId === message.sessionId) {
                  this.permissionMode = message.permission.mode;
                  this.permissionChangedAt = message.permission.changedAt;
                }
                this.pushEvent('session_created', `Created session ${message.sessionId}`);
                this.dispatchRunTurn(pendingTurn);
                return;
              }
              case 'session_subscribed': {
                const pending = this.pendingSessionSubscription;
                if (
                  pending?.type !== 'subscribe_session'
                  || message.requestId !== pending.requestId
                  || message.sessionId !== pending.sessionId
                ) {
                  this.pushEvent('session_subscribed', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.pendingSessionSubscription = null;
                if (pending.owner === 'child') {
                  this.childSubscriptionStatus = 'subscribed';
                  this.childUnavailable = false;
                  this.requestSessionHistory(message.sessionId, { latest: true });
                  this.scrollChatToBottom(message.sessionId, { force: true });
                  if (this.childPendingAction) {
                    this.beginChildTransition(this.childPendingAction);
                  }
                } else {
                  this.focusedSessionSubscribed = true;
                  this.requestPermissionMode();
                  this.requestSessionHistory(message.sessionId, { latest: true });
                  this.$refs.sidebarPanel?.closeMobileSidebar();
                  if (this.openedChildSessionId) {
                    this.activateChildDetail(this.openedChildSessionId);
                  }
                }
                this.pushEvent('session_subscribed', `Subscribed to Session ${message.sessionId}`);
                return;
              }
              case 'session_unsubscribed': {
                const pending = this.pendingSessionSubscription;
                if (
                  pending?.type !== 'unsubscribe_session'
                  || message.requestId !== pending.requestId
                  || message.sessionId !== pending.sessionId
                ) {
                  this.pushEvent('session_unsubscribed', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.pendingSessionSubscription = null;
                if (pending.owner === 'child') {
                  this.completeChildTransition();
                } else {
                  this.activateFocusedSession(pending.targetSessionId);
                }
                return;
              }
              case 'session_subscription_error': {
                const pending = this.pendingSessionSubscription;
                if (
                  pending?.type !== 'subscribe_session'
                  || message.requestId !== pending.requestId
                  || message.sessionId !== pending.sessionId
                ) {
                  this.pushEvent('session_subscription_error', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.pendingSessionSubscription = null;
                if (pending.owner === 'child') {
                  this.childSubscriptionStatus = 'unavailable';
                  this.childUnavailable = true;
                  this.pushEvent(
                    'session_subscription_error',
                    `${message.code}: Child Session subscription failed.`,
                  );
                  if (this.childPendingAction) {
                    this.completeChildTransition();
                  }
                } else {
                  this.sessionsError = `${message.code}: Session subscription failed.`;
                  this.pushEvent('session_subscription_error', this.sessionsError);
                  this.$refs.sidebarPanel?.closeMobileSidebar();
                }
                return;
              }
              case 'session_permission_mode_changed': {
                if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
                  this.pushEvent('permission', 'Ignored permission update without a Session ID');
                  return;
                }
                const state = this.ensureSessionState(message.sessionId);
                if ((message.mode !== 'manual' && message.mode !== 'allow_all')
                  || !Number.isFinite(message.changedAt)
                  || message.changedAt < state.permissionChangedAt) {
                  this.pushEvent('permission', 'Ignored invalid or unrelated permission update');
                  return;
                }
                state.pendingPermissionRequestId = null;
                state.permissionMode = message.mode;
                state.permissionChangedAt = message.changedAt;
                this.pushEvent('permission', `Session permission mode is ${message.mode}`);
                return;
              }
              case 'sessions_listed':
                if (message.requestId !== this.pendingSessionsRequestId) {
                  this.pushEvent('sessions_listed', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.finishSessionListRequest();
                if (!Array.isArray(message.sessions)) {
                  this.sessionsError = 'Invalid Session list response.';
                  this.pushEvent('sessions_listed', this.sessionsError);
                  return;
                }
                this.sessions = message.sessions;
                this.sessionsError = '';
                this.pushEvent('sessions_listed', `Loaded ${message.sessions.length} Session(s)`);
                return;
              case 'session_history': {
                const state = this.ensureSessionState(message.sessionId);
                if (message.requestId !== state.pendingHistoryRequest?.requestId) {
                  this.pushEvent('session_history', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                const pending = state.pendingHistoryRequest;
                const pendingWasEarlier = Boolean(pending.beforeEntryId);
                const scrollAnchor = pendingWasEarlier
                  ? this.captureHistoryScrollAnchor(message.sessionId)
                  : null;
                const settlement = applyHistoryPage(state, message);
                this.syncApprovalCards();
                if (settlement.deferredTerminalTurnIds.length > 0) {
                  this.requestSessionHistory(message.sessionId, {
                    latest: true,
                    terminalTurnIds: settlement.deferredTerminalTurnIds,
                  });
                }
                if (
                  message.sessionId === this.form.sessionId
                  || message.sessionId === this.openedChildSessionId
                ) {
                  if (settlement.pendingWasEarlier) {
                    this.restoreHistoryScrollAnchor(message.sessionId, scrollAnchor);
                  } else {
                    this.scrollChatToBottom(message.sessionId);
                  }
                }
                this.pushEvent('session_history', `Loaded ${message.items?.length ?? 0} message record(s)`);
                return;
              }
              case 'session_history_error': {
                const state = this.ensureSessionState(message.sessionId);
                if (message.requestId !== state.pendingHistoryRequest?.requestId) {
                  this.pushEvent('session_history', `Ignored unexpected error ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                const error = `${message.code}: ${message.message}`;
                const settlement = failHistoryRequest(state, error);
                if (
                  message.sessionId === this.openedChildSessionId
                  && message.code === 'SESSION_NOT_FOUND'
                ) {
                  this.childUnavailable = true;
                  this.childSubscriptionStatus = 'unavailable';
                }
                if (settlement.deferredTerminalTurnIds.length > 0) {
                  this.requestSessionHistory(message.sessionId, {
                    latest: true,
                    terminalTurnIds: settlement.deferredTerminalTurnIds,
                  });
                }
                this.pushEvent('session_history', error);
                return;
              }
              case 'session_renamed': {
                const pending = this.pendingSessionOperation;
                if (
                  pending?.type !== 'rename'
                  || message.requestId !== pending.requestId
                  || message.session?.sessionId !== pending.sessionId
                ) {
                  this.pushEvent('session_renamed', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.pendingSessionOperation = null;
                this.upsertSession(message.session);
                this.sessionsError = '';
                this.pushEvent('session_renamed', `Renamed Session ${pending.sessionId}`);
                return;
              }
              case 'session_deleted': {
                const pending = this.pendingSessionOperation;
                if (
                  pending?.type !== 'delete'
                  || message.requestId !== pending.requestId
                  || message.sessionId !== pending.sessionId
                ) {
                  this.pushEvent('session_deleted', `Ignored unexpected response ${message.requestId ?? '(missing id)'}`);
                  return;
                }
                this.pendingSessionOperation = null;
                this.sessions = this.sessions.filter(
                  session => session.sessionId !== pending.sessionId,
                );
                delete this.sessionStates[pending.sessionId];
                if (this.form.sessionId === pending.sessionId) {
                  const replacement = this.sessions[0];
                  this.switchFocusedSession(replacement?.sessionId ?? '');
                }
                this.sessionsError = '';
                this.pushEvent('session_deleted', `Deleted Session ${pending.sessionId}`);
                return;
              }
              case 'approval_requested': {
                if (!this.validApproval(message)) return;
                this.pendingApprovals.set(message.id, message);
                this.syncApprovalCards();
                this.scrollChatToBottom(message.sessionId);
                this.pushEvent(
                  'approval',
                  `Approval requested for ${message.toolName} in ${this.shortSessionId(message.sessionId)}`,
                );
                return;
              }
              case 'session_approvals':
                if (message.requestId !== this.pendingApprovalsRequestId) return;
                this.finishApprovalsRequest();
                if (message.sessionId !== undefined || !Array.isArray(message.approvals)
                  || !message.approvals.every(request => this.validApproval(request))) {
                  this.pushEvent('error', 'Invalid pending Approval response.');
                  return;
                }
                this.pendingApprovals = new Map(message.approvals.map(request => [request.id, request]));
                this.syncApprovalCards();
                return;
              case 'session_approvals_error':
                if (message.requestId !== this.pendingApprovalsRequestId) return;
                this.finishApprovalsRequest();
                this.pushEvent('error', `${message.code}: ${message.message}`);
                return;
              case 'approval_closed': {
                const request = this.pendingApprovals.get(message.id);
                if (request && request.sessionId === message.sessionId
                  && request.turnId === message.turnId && request.callId === message.callId) {
                  this.pendingApprovals.delete(message.id);
                }
                this.markApprovalClosed(
                  message.id,
                  message.outcome,
                  message.reason,
                  message.sessionId,
                  message.turnId,
                  message.callId,
                );
                this.syncApprovalCards();
                this.pushEvent('approval', `Approval ${message.outcome}: ${message.id}`);
                return;
              }
              case 'channel_error':
                this.activeSessionState.isSending = false;
                this.pendingSessionRequestId = null;
                this.pendingFirstTurn = null;
                this.pendingPermissionRequestId = null;
                if (this.pendingSessionOperation !== null) {
                  this.pendingSessionOperation = null;
                  this.closeSidebarTransientUi();
                  this.sessionsError = `${message.code}: ${message.message}`;
                }
                if (this.pendingSessionsRequestId !== null) {
                  this.finishSessionListRequest();
                  this.sessionsError = `${message.code}: ${message.message}`;
                }
                this.pushEvent('channel_error', `${message.code}: ${message.message}`);
                this.appendChatItem({ kind: 'error', label: 'Channel', text: `${message.code}: ${message.message}` });
                return;
            }
            this.handleAgentEvent(message);
          },

          handleAgentEvent(event) {
            const sessionId = resolveEventSessionId(event, this.form.sessionId);
            const state = this.ensureSessionState(sessionId);
            const effects = applyAgentEvent(state, event, {
              clientId: this.form.clientId,
              nextId: () => this.nextId++,
            });
            for (const effect of effects) {
              switch (effect.type) {
                case 'event':
                  this.pushEvent(effect.title, effect.detail);
                  break;
                case 'protocol_error':
                  this.pushEvent('client_protocol_error', effect.detail);
                  break;
                case 'scroll':
                  this.scrollChatToBottom(sessionId);
                  break;
                case 'sync_approvals':
                  this.syncApprovalCards();
                  break;
                case 'refresh_history':
                  this.requestSessionHistory(sessionId, {
                    latest: true,
                    terminalTurnId: effect.turnId,
                  });
                  break;
                case 'refresh_model_catalog':
                  this.clearModelSelection();
                  this.pushEvent(
                    'model_catalog',
                    'Selected model is unavailable; refreshing the Catalog for reselection',
                  );
                  this.requestModelCatalog();
                  break;
              }
            }
          },

          appendChatItem(fields, sessionId = this.form.sessionId, options = {}) {
            const state = this.ensureSessionState(sessionId);
            const item = appendConversationItem(state, fields, {
              nextId: () => this.nextId++,
            });
            this.scrollChatToBottom(sessionId, { force: options.forceScroll === true });
            return item;
          },

          markApprovalClosed(approvalId, outcome, reason, sessionId, turnId, callId) {
            const state = this.ensureSessionState(sessionId);
            applyApprovalClosed(state, approvalId, outcome, reason, turnId, callId);
          },

          startNewSession() {
            this.sessionStates[''] = createSessionUiState();
            this.switchFocusedSession('');
          },
          selectSession(session) {
            if (
              !session?.sessionId
              || this.pendingSessionRequestId !== null
              || this.pendingSessionSubscription?.owner === 'parent'
            ) {
              return;
            }
            this.switchFocusedSession(session.sessionId);
          },
          shortSessionId(sessionId) {
            return typeof sessionId === 'string' ? sessionId.slice(0, 8) : '';
          },
          formatSessionTime(timestamp) {
            if (!Number.isFinite(timestamp)) return '';
            return new Date(timestamp).toLocaleDateString([], {
              month: 'short',
              day: 'numeric',
            });
          },

          reconcileReasoningSelection() {
            this.closeSidebarTransientUi();
            const reset = [];
            if (
              this.reasoningSelection.thinking !== 'default'
              && !this.thinkingOptions.includes(this.reasoningSelection.thinking)
            ) {
              this.reasoningSelection.thinking = 'default';
              reset.push('Thinking');
            }
            if (
              this.reasoningSelection.effort !== 'default'
              && !this.effortOptions.includes(this.reasoningSelection.effort)
            ) {
              this.reasoningSelection.effort = 'default';
              reset.push('Effort');
            }
            this.reasoningNotice = reset.length > 0
              ? `${reset.join(' and ')} reset to Default because the selected model does not support the previous value.`
              : '';
          },
          isThinkingOptionDisabled(value) {
            return value === 'on' && this.reasoningSelection.effort === 'none';
          },
          isEffortOptionDisabled(value) {
            return this.reasoningSelection.thinking === 'off'
              && value !== 'none';
          },
          currentReasoningPreference() {
            return Object.freeze({
              ...(this.reasoningSelection.thinking !== 'default'
                ? { thinking: this.reasoningSelection.thinking }
                : {}),
              effort: this.reasoningSelection.effort,
            });
          },
          formatReasoningOption(value) {
            return value === 'xhigh'
              ? 'Extra high'
              : value.charAt(0).toUpperCase() + value.slice(1);
          },
          // ── Misc helpers ──────────────────────────────────────
          pushEvent(title, detail) {
            this.eventFeed.unshift({ id: this.nextEventId++, title, detail });
            if (this.eventFeed.length > MAX_EVENT_FEED_ITEMS) {
              this.eventFeed.length = MAX_EVENT_FEED_ITEMS;
            }
          },
          scrollChatToBottom(sessionId = this.form.sessionId, options = {}) {
            if (sessionId === this.openedChildSessionId) {
              this.$refs.childDetailPanel?.scrollToBottom(
                sessionId,
                options.force === true,
              );
              return;
            }
            this.$refs.conversationPanel?.scrollToBottom(
              sessionId,
              options.force === true,
            );
          },
          captureHistoryScrollAnchor(sessionId) {
            if (sessionId === this.openedChildSessionId) {
              return this.$refs.childDetailPanel?.captureHistoryScrollAnchor(sessionId) ?? null;
            }
            return this.$refs.conversationPanel?.captureHistoryScrollAnchor(sessionId) ?? null;
          },
          restoreHistoryScrollAnchor(sessionId, anchor) {
            if (sessionId === this.openedChildSessionId) {
              this.$refs.childDetailPanel?.restoreHistoryScrollAnchor(sessionId, anchor);
              return;
            }
            this.$refs.conversationPanel?.restoreHistoryScrollAnchor(sessionId, anchor);
          },
        },
      });
</script>

<template>
<SidebarPanel
  ref="sidebarPanel"
  :status-class="statusClass"
  :last-status-message="lastStatusMessage"
  :connection-status-label="connectionStatusLabel"
  :model-catalog="modelCatalog"
  :available-models="availableModels"
  :available-model-providers="availableModelProviders"
  :model-picker-label="modelPickerLabel"
  :selected-model-details="selectedModelDetails"
  :show-thinking-control="showThinkingControl"
  :show-effort-control="showEffortControl"
  :reasoning-selection="reasoningSelection"
  :reasoning-notice="reasoningNotice"
  :reasoning-constraint-notice="reasoningConstraintNotice"
  :pending-session-request-id="pendingSessionRequestId"
  :pending-session-operation="pendingSessionOperation"
  :selected-session-id="form.sessionId"
  :chat-item-count="chatItems.length"
  :pending-sessions-request-id="pendingSessionsRequestId"
  :sessions="sessions"
  :sessions-error="sessionsError"
  :is-connected="isConnected"
  :permission-mode="permissionMode"
  :theme="theme"
  :pending-permission-request-id="pendingPermissionRequestId"
  :format-reasoning-option="formatReasoningOption"
  :reasoning-picker-options="reasoningPickerOptions"
  :is-reasoning-picker-option-disabled="isReasoningPickerOptionDisabled"
  :model-option-token="modelOptionToken"
  :is-selected-model="isSelectedModel"
  :is-runtime-default-model="isRuntimeDefaultModel"
  :has-session-approvals="hasSessionApprovals"
  :format-session-time="formatSessionTime"
  :short-session-id="shortSessionId"
  @sidebar-visibility-changed="$refs.conversationPanel?.setSidebarOpen($event)"
  @mobile-sidebar-closed="$refs.conversationPanel?.getMobileSidebarTrigger()?.focus()"
  @select-model="selectModel"
  @select-reasoning-option="selectReasoningOption"
  @start-new-session="startNewSession"
  @select-session="selectSession"
  @rename-session="renameSessionFromMenu"
  @delete-session="deleteSessionFromMenu"
  @select-permission-mode="selectPermissionMode"
  @select-theme="selectTheme"
/>

<main class="panel chat-shell" :class="{ 'has-child-detail': openedChildSessionId }">
  <div class="conversation-column">
    <ConversationPanel
      ref="conversationPanel"
      :current-session-label="currentSessionLabel"
      :pending-approval-count="pendingApprovalCount"
      :is-connected="isConnected"
      :connection-status="connectionStatus"
      :history-status="historyStatus"
      :displayed-chat-items="displayedChatItems"
      :session-id="form.sessionId"
      :opened-child-session-id="openedChildSessionId"
      :history-has-more="historyHasMore"
      :history-error="historyError"
      :can-retry-history="Boolean(activeSessionState.failedHistoryRequest)"
      @open-sidebar="openMobileSidebar"
      @load-earlier-history="loadEarlierHistory"
      @retry-history="retryHistory"
      @resolve-approval="resolveApproval"
      @open-subagent="openChildDetail"
    />

    <ComposerPanel
      v-model="draft"
      :attachments="attachments"
      :attach-error="attachError"
      :selected-model-supports-images="selectedModelSupportsImages"
      :attachment-capability-explanation="attachmentCapabilityExplanation"
      :is-waiting-for-reply="isWaitingForReply"
      :max-attachments-per-message="maxAttachmentsPerMessage"
      :is-connected="isConnected"
      :can-send="canSend"
      :pending-approval-count="pendingApprovalCount"
      @files="ingestFiles"
      @remove-attachment="removeAttachment"
      @reset="resetComposer"
      @abort="abortTurn"
      @send="sendMessage"
    />
  </div>

  <ChildDetailPanel
    v-if="openedChildSessionId && childSessionState"
    ref="childDetailPanel"
    :session-id="openedChildSessionId"
    :subscription-status="childSubscriptionStatus"
    :unavailable="childUnavailable"
    :history-status="childSessionState.historyStatus"
    :history-error="childSessionState.historyError"
    :history-has-more="childSessionState.historyHasMore"
    :can-retry-history="Boolean(childSessionState.failedHistoryRequest)"
    :displayed-items="childDisplayedItems"
    @close="closeChildDetail"
    @load-earlier-history="loadEarlierChildHistory"
    @retry-history="retryChildHistory"
  />
</main>
</template>
