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
    ];
    const sources = await Promise.all(
      requiredFiles.map(path => readFile(`${CLIENT_ROOT}/src/${path}`, 'utf8')),
    );
    expect(sources).toHaveLength(requiredFiles.length);

    const appSource = sources[0];
    const sidebarSource = sources[1];
    const conversationSource = sources[2];
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
    expect(conversationSource).toContain('captureHistoryScrollAnchor');
    expect(conversationSource).toContain('restoreHistoryScrollAnchor');
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
  });
});
