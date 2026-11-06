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
import { createSessionUiState } from '../client/session-state';

let MessageItem: Component;
let ApprovalPanel: Component;

beforeAll(async () => {
  MessageItem = await loadComponent('./MessageItem.vue');
  ApprovalPanel = await loadComponent('./ApprovalPanel.vue');
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
    expect(html).toContain('LLM call 1');

    addTool('second');
    html = await render(item);
    expect(html).toContain('class="tool-call-group"');
    expect(html).toContain('class="tool-group-header"');
    expect(html).toContain('data-tool-call-id="first"');
    expect(html).toContain('data-tool-call-id="second"');
    expect(html).toContain('LLM call 1');
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
    expect(html).toContain('LLM call 1');
    expect(html).toContain('1 tool');
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
    expect(html).toContain('LLM call 1');
    expect(html).toContain('LLM call 1');
  });
});
