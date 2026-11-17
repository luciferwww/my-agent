import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSSRApp, type Component } from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';
import * as conversation from '../client/conversation';
import type { ConversationItem } from '../client/conversation';
import { buildHistoryItems } from '../client/history';
import * as markdown from '../client/markdown';
import * as toolPresentation from '../client/tool-presentation';
import { createSessionUiState } from '../client/session-state';

let MessageItem: Component;
let ApprovalPanel: Component;
let ConversationPanel: Component;

beforeAll(async () => {
  MessageItem = await loadComponent('./MessageItem.vue');
  ApprovalPanel = await loadComponent('./ApprovalPanel.vue');
  ConversationPanel = await loadComponent('./ConversationPanel.vue');
});

async function loadComponent(path: string): Promise<Component> {
  const filename = fileURLToPath(new URL(path, import.meta.url));
  const source = await readFile(filename, 'utf8');
  const parsed = parse(source, { filename });
  expect(parsed.errors).toEqual([]);
  const compiled = compileScript(parsed.descriptor, { id: 'message-item', inlineTemplate: true });
  const output = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const require = createRequire(import.meta.url);
  const module: { exports: { default?: Component } } = { exports: {} };
  new Function('require', 'module', 'exports', output.outputText)(
    (specifier: string) => {
      if (specifier === '../client/conversation') return conversation;
      if (specifier === '../client/markdown') return markdown;
      if (specifier === '../client/tool-presentation') return toolPresentation;
      if (specifier === './MessageItem.vue') return { default: MessageItem };
      return require(specifier);
    },
    module,
    module.exports,
  );
  if (!module.exports.default) throw new Error(`Compiled component is missing: ${path}`);
  return module.exports.default;
}

function render(item: ConversationItem, itemsBySession: Record<string, ConversationItem[]> = {}) {
  return renderToString(createSSRApp(MessageItem, {
    item, isConnected: true, sourceSessionId: 'root', itemsBySession, scopes: [],
  }));
}

function renderConversation(items: ConversationItem[], children: Record<string, ConversationItem[]> = {}) {
  return renderToString(createSSRApp(ConversationPanel, {
    displayedChatItems: items, sessionId: 'root', itemsBySession: { root: items, ...children },
    scopes: [], currentSessionLabel: 'Root', pendingApprovalCount: 0,
    isConnected: true, connectionStatus: 'connected', historyStatus: 'loaded',
    historyHasMore: false, historyError: '', canRetryHistory: false,
  }));
}

describe('Assistant Turn headings', () => {
  function messages(turnId = 'c5b64474-turn'): ConversationItem[] {
    return buildHistoryItems([
      { entryId: 'read', messageId: 'read', turnId, role: 'assistant', llmRound: 0,
        timestamp: '2026-11-12T07:55:03Z',
        content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'a.txt' } }] },
      { entryId: 'change', messageId: 'change', turnId, role: 'assistant', llmRound: 1,
        timestamp: '2026-11-12T07:55:06Z',
        content: [{ type: 'tool_use', id: 'change', name: 'edit_file', input: { path: 'a.txt' } }] },
      { entryId: 'answer', messageId: 'answer', turnId, role: 'assistant', llmRound: 2,
        timestamp: '2026-11-12T07:55:09Z', content: [{ type: 'text', text: 'Finished.' }] },
    ]);
  }

  it('renders one heading and first timestamp without merging messages or Tool groups', async () => {
    const items = messages();
    const html = await renderConversation(items);
    expect(html.match(/>Assistant<\/span>/gu)).toHaveLength(1);
    expect(html.match(/>turn c5b64474<\/span>/gu)).toHaveLength(1);
    expect(html).toContain(conversation.formatTime(items[0].timestamp));
    expect(html).not.toContain(conversation.formatTime(items[1].timestamp));
    expect(html).not.toContain(conversation.formatTime(items[2].timestamp));
    expect(html.match(/data-chat-item-id=/gu)).toHaveLength(3);
    expect(html.match(/class="tool-call-group"/gu)).toHaveLength(2);
    expect(html.indexOf('data-tool-call-id="read"')).toBeLessThan(html.indexOf('data-tool-call-id="change"'));
    expect(html.indexOf('data-tool-call-id="change"')).toBeLessThan(html.indexOf('Finished.'));
    expect(items.map(item => item.messageId)).toEqual(['read', 'change', 'answer']);
  });

  it('preserves interleaved text, Thinking and disclosure state', async () => {
    const items = messages();
    items[0].segments![0].toolGroup!.expanded = false;
    items.splice(1, 0, {
      kind: 'turn', label: 'Assistant', id: 'interleaved', turnId: items[0].turnId,
      timestamp: items[0].timestamp + 1000,
      segments: [
        { id: 'text', type: 'text', text: 'Before editing.' },
        { id: 'thinking', type: 'thinking', text: 'Keep this reasoning.', expanded: true, status: 'complete' },
      ],
    });
    const html = await renderConversation(items);
    expect(html.match(/>Assistant<\/span>/gu)).toHaveLength(1);
    expect(html).not.toContain('data-tool-call-id="read"');
    expect(html.indexOf('1 file read')).toBeLessThan(html.indexOf('Before editing.'));
    expect(html.indexOf('Before editing.')).toBeLessThan(html.indexOf('Keep this reasoning.'));
    expect(html.indexOf('Keep this reasoning.')).toBeLessThan(html.indexOf('data-tool-call-id="change"'));
    expect(items[0].segments![0].toolGroup!.expanded).toBe(false);
  });

  it('does not group different full Turn IDs, legacy unidentified messages or Approval headings', async () => {
    const first = messages()[0];
    const second = { ...messages('c5b64474-other')[0], id: 'other' };
    const legacy = [undefined, null, ''].map((turnId, index) => ({
      ...first, id: `legacy-${index}`, turnId,
    }));
    const approval = { ...first, id: 'approval', label: 'Approval' };
    const html = await renderConversation([first, second, ...legacy, approval]);
    expect(html.match(/>Assistant<\/span>/gu)).toHaveLength(5);
    expect(html).toContain('>Approval</span>');
  });

  it('keeps steering messages and status tags in place without repeating the Turn heading', async () => {
    const items = messages();
    items[0].interrupted = true;
    items[1].isContinuation = true;
    items.splice(1, 0, {
      kind: 'user', label: 'You', id: 'steer', turnId: items[0].turnId,
      timestamp: items[0].timestamp + 1000, isSteer: true, text: 'Change direction.',
    });
    const html = await renderConversation(items);
    expect(html.match(/>Assistant<\/span>/gu)).toHaveLength(1);
    expect(html).toContain('>steered</span>');
    expect(html).toContain('>continued</span>');
    expect(html).toContain('>steer</span>');
    expect(html.indexOf('data-tool-call-id="read"')).toBeLessThan(html.indexOf('Change direction.'));
    expect(html.indexOf('Change direction.')).toBeLessThan(html.indexOf('data-tool-call-id="change"'));
  });

  it('groups each Child independently from its Parent and sibling even when Turn IDs match', async () => {
    const parent = messages()[0];
    parent.segments = ['child-a', 'child-b'].map(id => ({
      type: 'tool_call', id, callId: id, name: 'task', input: {}, status: 'success',
      subagentSessionId: id, subagentExpanded: true,
    }));
    const children = Object.fromEntries(['child-a', 'child-b'].map(id => [
      id, messages().map(item => ({ ...item, id: `${id}-${item.id}` })),
    ]));
    const html = await renderConversation([parent], children);
    expect(html.match(/>Assistant<\/span>/gu)).toHaveLength(3);
    expect(html.match(/>turn c5b64474<\/span>/gu)).toHaveLength(3);
    expect(html.match(/Finished\./gu)).toHaveLength(2);
  });

  it('retains the first live timestamp as more text arrives', () => {
    const state = createSessionUiState();
    let id = 0;
    let now = 1000;
    const context = { clientId: 'observer', nextId: () => ++id, now: () => now };
    conversation.applyAgentEvent(state, {
      type: 'text_delta', turnId: 'turn', messageId: 'message', text: 'First',
    }, context);
    now = 5000;
    conversation.applyAgentEvent(state, {
      type: 'text_delta', turnId: 'turn', messageId: 'message', text: ' next',
    }, context);
    expect(state.chatItems[0].timestamp).toBe(1000);
    expect(state.chatItems[0].segments![0].text).toBe('First next');
  });
});

function history(toolCount: number): ConversationItem {
  return buildHistoryItems([{
    entryId: 'assistant', messageId: 'assistant', turnId: 'turn',
    role: 'assistant', llmRound: 0,
    content: Array.from({ length: toolCount }, (_, index) => ({
      type: 'tool_use', id: `tool-${index}`, name: 'read_file', input: { path: `${index}.txt` },
    })),
  }])[0];
}

describe('Tool group presentation', () => {
  it('labels Skill loading explicitly in live and historical groups', async () => {
    const state = createSessionUiState();
    let id = 0;
    const context = { clientId: 'observer', nextId: () => ++id };
    for (const event of [
      { type: 'llm_call', messageId: 'skill-message', round: 0 },
      { type: 'tool_call_requested', callId: 'skill-call', messageId: 'skill-message',
        name: 'skill', input: { name: 'manual-test' } },
      { type: 'tool_result', callId: 'skill-call', result: { status: 'success', content: 'Instructions' } },
    ]) conversation.applyAgentEvent(state, { turnId: 'turn', ...event }, context);
    const historical = buildHistoryItems([{
      entryId: 'skill-message', messageId: 'skill-message', turnId: 'turn', role: 'assistant', llmRound: 0,
      content: [{ type: 'tool_use', id: 'skill-call', name: 'skill', input: { name: 'manual-test' },
        status: 'success', result_content: 'Instructions' }],
    }]);
    for (const item of [state.chatItems[0], historical[0]]) {
      const collapsed = await render(item);
      expect(collapsed).toContain('1 skill load');
      expect(collapsed).not.toContain('other operation');
      const group = item.segments![0].toolGroup;
      if (!group) throw new Error('Missing Skill Tool group.');
      group.expanded = true;
      const expanded = await render(item);
      expect(expanded).toContain('Load Skill manual-test');
      expect(expanded).toContain('Succeeded');
    }
  });

  it.each(['success', 'aborted'])('exposes the %s status on historical Tool and Subagent badges', async status => {
    const item = buildHistoryItems([{
      entryId: 'message', turnId: 'turn', role: 'assistant',
      content: [{
        type: 'tool_use', id: 'tool', name: 'task', input: { description: 'Check references' },
        status, result_content: status === 'aborted' ? 'Tool approval aborted: shutdown.' : 'done',
      }],
    }])[0];
    item.segments![0].subagentSessionId = 'child';
    item.segments![0].subagentOutcome = status === 'success' ? 'ok' : 'aborted';
    const html = await render(item);
    expect(html).toContain(`class="tool-result-badge" data-status="${status}"`);
    expect(html).toContain(`class="tool-result-badge" data-status="${status === 'success' ? 'ok' : 'aborted'}"`);
    expect(html).toContain(status === 'success' ? 'Succeeded' : 'Aborted');
  });

  it('keeps the same filename title when closed and open, with complete input in details', async () => {
    const item = history(1);
    const segment = item.segments![0];
    segment.input = { path: 'C:\\full\\path\\a.ts', startLine: 10, endLine: 20 };
    segment.expanded = false;
    const closed = await render(item);
    segment.expanded = true;
    const open = await render(item);
    const title = /<span class="tool-result-name"[^>]*>.*?<\/span>/su;
    expect(closed.match(title)?.[0]).toBe(open.match(title)?.[0]);
    expect(open).toContain('Read a.ts, lines 10–20');
    expect(open).toContain('C:\\\\full\\\\path\\\\a.ts');
    expect(open).not.toContain('>read_file</span>');
  });

  it('renders task description and agent type separately without promoting its prompt', async () => {
    const item = history(1);
    item.segments![0].name = 'task';
    item.segments![0].input = {
      subagent_type: 'researcher', description: 'Find & compare references', prompt: 'Full task instructions',
    };
    const html = await render(item);
    expect(html).toContain('class="tool-agent-label">Researcher</span>');
    expect(html).toContain('Find &amp; compare references');
    expect(html).not.toMatch(/class="tool-result-name"[^>]*>[^<]*Full task instructions/u);
  });

  it('renders one approval at the composer independently of loaded slots and disables disconnected actions', async () => {
    const approvals = ['a', 'b'].map(id => ({
      id, sessionId: 'root', turnId: id, callId: id, toolName: `tool-${id}`, input: { command: id },
    }));
    const props = { sessionId: 'root', approvals, sources: { a: 'Child A' }, isConnected: true };
    const html = await renderToString(createSSRApp(ApprovalPanel, props));
    expect(html).toContain('data-approval-id="a"');
    expect(html).not.toContain('data-approval-id="b"');
    expect(html).toContain('1 / 2');
    expect(html).toContain('Child A');
    expect(html).toContain('Allow</button>');
    expect(html).toContain('Deny</button>');
    const offline = await renderToString(createSSRApp(ApprovalPanel, { ...props, isConnected: false }));
    expect(offline).toContain('Reconnect to respond');
    expect(offline).toMatch(/disabled[^>]*>Allow<\/button>/u);
    const empty = await renderToString(createSSRApp(ApprovalPanel, { ...props, approvals: [] }));
    expect(empty).not.toContain('Pending approvals');
  });

  it('shows a group from the first live tool and retains it when the second tool arrives', async () => {
    const state = createSessionUiState();
    let id = 0;
    const context = { clientId: 'observer', nextId: () => ++id };
    conversation.applyAgentEvent(state, {
      type: 'llm_call', turnId: 'turn', messageId: 'assistant', round: 0,
    }, context);
    const addTool = (callId: string) => conversation.applyAgentEvent(state, {
      type: 'tool_call_requested', turnId: 'turn', messageId: 'assistant',
      callId, name: 'read_file', input: {},
    }, context);
    addTool('first');
    const item = state.chatItems[0];
    const group = item.segments![0].toolGroup;
    let html = await render(item);
    expect(html).toContain('data-tool-call-id="first"');
    expect(html).toContain('class="tool-call-group"');
    expect(html).toContain('class="tool-group-header"');
    expect(html).toContain('1 file read');
    expect(html).not.toContain('LLM call');

    addTool('second');
    html = await render(item);
    expect(html).toContain('class="tool-call-group"');
    expect(html).toContain('class="tool-group-header"');
    expect(html).toContain('data-tool-call-id="first"');
    expect(html).toContain('data-tool-call-id="second"');
    expect(html).toContain('2 file reads');
    expect(item.segments!.every(segment => segment.toolGroup === group)).toBe(true);

    if (!group) throw new Error('Observed LLM group is missing');
    group.expanded = false;
    html = await render(item);
    expect(html).toContain('class="tool-group-header"');
    expect(html).not.toContain('data-tool-call-id="first"');
    expect(html).not.toContain('data-tool-call-id="second"');
  });

  it('keeps a historical singleton grouped and collapsible without duplicating approval controls', async () => {
    const item = history(1);
    const segment = item.segments![0];
    if (!segment.toolGroup) throw new Error('Historical LLM group is missing');
    segment.toolGroup.expanded = false;
    segment.approval = { id: 'approval', toolName: 'read_file', status: 'pending', input: {} };
    segment.status = 'approval';
    const html = await render(item);
    expect(html).toContain('class="tool-group-header"');
    expect(html).toContain('class="tool-call-group"');
    expect(html).not.toContain('data-tool-call-id="tool-0"');
    expect(html).not.toContain('Allow</button>');
    expect(html).not.toContain('Deny</button>');
    expect(html).toContain('Approval required');
    expect(html).toContain('1 file read');
    expect(html).not.toContain('1 tool');
    expect(segment.toolGroup.expanded).toBe(false);
  });

  it('retains the group header and both cards for multiple historical tools', async () => {
    const html = await render(history(2));
    expect(html).toContain('class="tool-call-group"');
    expect(html).toContain('class="tool-group-header"');
    expect(html).toContain('data-tool-call-id="tool-0"');
    expect(html).toContain('data-tool-call-id="tool-1"');
  });

  it('shows groups for both a singleton Parent and its multi-tool Child', async () => {
    const parent = history(1);
    parent.segments![0].subagentSessionId = 'child';
    const html = await render(parent, { child: [history(2)] });
    expect(html).toContain('data-subagent-session-id="child"');
    expect(html.match(/class="tool-call-group"/gu)).toHaveLength(2);
    expect(html.match(/class="tool-group-header"/gu)).toHaveLength(2);
    expect(html.match(/class="tool-result-card"/gu)).toHaveLength(3);
    expect(html).toContain('1 file read');
    expect(html).toContain('2 file reads');
  });
});
