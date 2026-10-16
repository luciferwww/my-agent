import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('migrated WebSocket Client', () => {
  it('keeps the accepted coarse-component and typed-module layout', async () => {
    const requiredFiles = [
      'App.vue',
      'components/SidebarPanel.vue',
      'components/ConversationPanel.vue',
      'components/ComposerPanel.vue',
      'components/MessageItem.vue',
      'client/protocol.ts',
      'client/socket.ts',
      'client/session-state.ts',
      'client/history.ts',
      'client/conversation.ts',
      'client/theme.ts',
      'attachments.ts',
      'client/markdown.ts',
      'components/ChildDetailPanel.vue',
    ];
    const sources = await Promise.all(
      requiredFiles.map(path => readFile(`${CLIENT_ROOT}/src/${path}`, 'utf8')),
    );
    expect(sources).toHaveLength(requiredFiles.length);

    const appSource = sources[0];
    const sidebarSource = sources[1];
    const conversationSource = sources[2];
    const messageSource = sources[4];
    const childDetailSource = sources[13];
    for (const ownedState of [
      'isMobileLayout',
      'modelPickerOpen',
      'reasoningPickerOpen',
      'permissionPickerOpen',
      'sessionActionMenu',
    ]) {
      expect(appSource).not.toContain(`${ownedState}:`);
      expect(sidebarSource).toContain(`${ownedState}:`);
    }
    expect(appSource).not.toContain('getChatLogElement');
    expect(appSource).not.toContain('CHAT_FOLLOW_THRESHOLD_PX');
    expect(appSource).not.toContain('new WebSocket');
    expect(appSource).not.toContain('reconnectTimer');
    expect(appSource).not.toContain("case 'thinking_start'");
    expect(appSource).not.toContain('getOrCreateTurn');
    expect(appSource).toContain('if (this.form.sessionId && !this.focusedSessionSubscribed)');
    expect(appSource).toContain('this.focusedSessionSubscribed = true');
    expect(appSource).toContain('openedChildSessionId');
    expect(appSource).toContain("owner = 'parent'");
    expect(appSource).toContain('completeChildTransition');
    expect(conversationSource).toContain('captureHistoryScrollAnchor');
    expect(conversationSource).toContain('restoreHistoryScrollAnchor');
    expect(childDetailSource).toContain('scrollToBottom');
    expect(childDetailSource).toContain('captureHistoryScrollAnchor');
    expect(childDetailSource).toContain('restoreHistoryScrollAnchor');
    expect(appSource).toContain('this.$refs.childDetailPanel?.scrollToBottom');
    expect(messageSource).toContain("'is-subagent-selected'");
    expect(messageSource).toContain('@click="openSubagentFromCard($event, segment)"');
    expect(messageSource).not.toContain('View detail');
    expect(messageSource).not.toContain('subagent-detail-action');
    expect(sources[9]).toContain('export function applyAgentEvent');
    expect(sources[6]).toContain('export class SocketClient');

    for (const path of [
      'app-template.html',
      'client/connection-methods.js',
      'client/session-methods.js',
      'client/model-methods.js',
      'client/composer-methods.js',
      'client/events-methods.js',
      'client/presentation-methods.js',
    ]) {
      await expect(readFile(`${CLIENT_ROOT}/src/${path}`, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('retains the critical permission-placement and local bundle invariants', async () => {
    const [indexSource, styleSource] = await Promise.all([
      readFile(`${CLIENT_ROOT}/index.html`, 'utf8'),
      readFile(`${CLIENT_ROOT}/src/style.css`, 'utf8'),
    ]);

    expect(indexSource).toContain('__MY_AGENT_CLIENT_CONFIG_JSON__');
    expect(indexSource).not.toContain('https://unpkg.com');
    expect(styleSource).toContain('.permission-picker-panel.placement-top');
    expect(styleSource).toContain('bottom: calc(100% + 8px)');
    expect(styleSource).toContain("html[data-theme='botanical']");
    expect(styleSource).toContain('.chat-shell.has-child-detail');
    expect(styleSource).toContain('.child-detail-scrim');
    expect(styleSource).toContain('@media (min-width: 1914px)');
    expect(styleSource).toContain('@media (min-width: 1724px)');
    expect(styleSource).toContain('grid-template-columns: minmax(0, 1fr) 450px');
    expect(styleSource).toContain('grid-template-columns: minmax(998px, 1fr) 450px');
    expect(styleSource).toContain('.tool-result-card.is-subagent-selected');
    expect(styleSource).toContain(
      "html[data-theme='botanical'] .message.assistant .bubble",
    );
  });
});
