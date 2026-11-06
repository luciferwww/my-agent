import { describe, expect, it } from 'vitest';
import type { ConversationSegment } from './conversation';
import { taskAgentLabel, toolDisplayTitle, toolGroupTitle } from './tool-presentation';

function tools(...names: string[]): ConversationSegment[] {
  return names.map((name, id) => ({ type: 'tool_call', id, name }));
}

describe('Tool group titles', () => {
  it.each([
    ['read_file', 'file read', 'file reads'],
    ['memory_get', 'file read', 'file reads'],
    ['file_search', 'search', 'searches'],
    ['grep_search', 'search', 'searches'],
    ['memory_search', 'search', 'searches'],
    ['exec', 'command', 'commands'],
    ['write_file', 'file change', 'file changes'],
    ['edit_file', 'file change', 'file changes'],
    ['apply_patch', 'file change', 'file changes'],
    ['memory_write', 'file change', 'file changes'],
    ['web_fetch', 'web fetch', 'web fetches'],
    ['list_dir', 'directory listing', 'directory listings'],
    ['process', 'process operation', 'process operations'],
    ['task', 'subagent task', 'subagent tasks'],
  ])('counts %s calls with singular and plural units', (name, singular, plural) => {
    expect(toolGroupTitle(tools(name))).toBe(`1 ${singular}`);
    expect(toolGroupTitle(tools(name, name))).toBe(`2 ${plural}`);
  });

  describe('Single Tool titles', () => {
    it.each([
      ['read_file', { path: 'C:\\src\\a.ts' }, 'Read a.ts'],
      ['read_file', { path: '/src/a.ts', startLine: 10, endLine: 20 }, 'Read a.ts, lines 10–20'],
      ['read_file', { path: 'a.ts', startLine: 10 }, 'Read a.ts, from line 10'],
      ['read_file', { path: 'a.ts', endLine: 20 }, 'Read a.ts, lines 1–20'],
      ['read_file', { path: 'a.ts', startLine: 10, endLine: 10 }, 'Read a.ts, line 10'],
      ['list_dir', { path: 'src\\components\\' }, 'List components'],
      ['list_dir', { path: '/' }, 'List /'],
      ['list_dir', { path: 'C:\\' }, 'List C:\\'],
      ['write_file', { path: 'src/config.json', content: 'not in title' }, 'Write config.json'],
      ['edit_file', { path: 'src/a.ts', oldText: 'old', newText: 'new' }, 'Edit a.ts'],
      ['apply_patch', { input: 'patch body is not parsed' }, 'Apply patch'],
      ['file_search', { query: '*.test.ts', path: 'src' }, 'Find files matching "*.test.ts"'],
      ['grep_search', { query: 'subagentExpanded', isRegexp: false, includePattern: '*.ts' }, 'Search for "subagentExpanded"'],
      ['exec', { command: 'npm test', cwd: 'hidden', env: { KEY: 'hidden' } }, 'Run npm test'],
      ['web_fetch', { url: 'https://user:password@example.com/docs/api/v1?q=secret#section' }, 'Fetch example.com/docs/api/...'],
      ['web_fetch', { url: 'http://example.com:8080/' }, 'Fetch example.com:8080'],
      ['web_fetch', { url: 'https://example.com/docs/' }, 'Fetch example.com/docs'],
      ['process', { action: 'list' }, 'List background processes'],
      ['process', { action: 'status', runId: 'run-1' }, 'Check process status · run-1'],
      ['process', { action: 'log', runId: 'run-1', tailLines: 5 }, 'Read process logs · run-1'],
      ['process', { action: 'kill', runId: 'run-1' }, 'Stop process · run-1'],
      ['memory_search', { query: 'title rules' }, 'Search memory for "title rules"'],
      ['memory_get', { path: 'memory/note.md', from: 10, lines: 5 }, 'Read memory note.md, lines 10–14'],
      ['memory_get', { path: 'MEMORY.md', from: 10 }, 'Read memory MEMORY.md, from line 10'],
      ['memory_get', { path: 'MEMORY.md', from: 10, lines: 1 }, 'Read memory MEMORY.md, line 10'],
      ['memory_get', { path: 'MEMORY.md', lines: 5 }, 'Read memory MEMORY.md'],
      ['memory_write', { path: 'memory/note.md', content: 'hidden' }, 'Append to memory note.md'],
      ['memory_write', { path: 'MEMORY.md', mode: 'append' }, 'Append to memory MEMORY.md'],
      ['memory_write', { path: 'MEMORY.md', mode: 'overwrite' }, 'Write memory MEMORY.md'],
      ['task', { description: 'Find Bing results', prompt: 'hidden' }, 'Find Bing results'],
    ])('formats %s without changing its input', (name, input, expected) => {
      const snapshot = structuredClone(input);
      const segment: ConversationSegment = { id: 'tool', type: 'tool_call', name, input };
      for (const expanded of [false, true]) {
        segment.expanded = expanded;
        expect(toolDisplayTitle(segment)).toBe(expected);
      }
      expect(input).toEqual(snapshot);
    });

    it.each([
      ['read_file', undefined],
      ['read_file', null],
      ['read_file', []],
      ['read_file', 'a.ts'],
      ['read_file', { path: 12 }],
      ['read_file', { path: ' ' }],
      ['read_file', { path: 'a.ts', startLine: 20, endLine: 10 }],
      ['read_file', { path: 'a.ts', startLine: 0 }],
      ['read_file', { path: 'a.ts', endLine: 1.5 }],
      ['read_file', { path: 'a.ts', startLine: '10' }],
      ['read_file', { path: 'a.ts', startLine: Infinity }],
      ['memory_get', { path: 'MEMORY.md', from: -1 }],
      ['memory_get', { path: 'MEMORY.md', lines: 0 }],
      ['memory_get', { path: 'MEMORY.md', from: Number.MAX_SAFE_INTEGER, lines: 2 }],
      ['memory_write', { path: 'MEMORY.md', mode: 'unknown' }],
      ['process', { action: 'unknown', runId: 'run-1' }],
      ['process', { action: 'log' }],
      ['process', { action: 'kill', runId: ' ' }],
      ['web_fetch', { url: 'invalid' }],
      ['web_fetch', { url: 'file:///local' }],
      ['task', { prompt: 'not used as a title' }],
      ['exec', { command: '' }],
      ['apply_patch', { input: '' }],
      ['grep_search', { query: {} }],
      ['custom_tool', { description: 'do not guess' }],
    ])('retains the raw name for unsupported %s input', (name, input) => {
      expect(toolDisplayTitle({ id: 1, type: 'tool_call', name, input })).toBe(name);
    });

    it('keeps task description separate from requested and actual agent types', () => {
      const task = tools('task')[0];
      task.input = { description: 'Find references', subagent_type: 'researcher' };
      expect(toolDisplayTitle(task)).toBe('Find references');
      expect(taskAgentLabel(task)).toBe('Researcher');
      expect(taskAgentLabel(task, 'general-purpose')).toBe('General purpose');
      task.input = {};
      expect(taskAgentLabel(task)).toBe('General purpose');
    });
  });

  it('combines semantic types in first occurrence order, counting calls not resources', () => {
    const segments = tools('exec', 'read_file', 'memory_get', 'file_search', 'grep_search', 'memory_search');
    segments[1].input = segments[2].input = { path: 'same.txt' };
    expect(toolGroupTitle(segments)).toBe('1 command, 2 file reads, 3 searches');
  });

  it('shows three known types and counts overflow and unknown calls together', () => {
    expect(toolGroupTitle(tools(
      'custom', 'read_file', 'exec', 'web_fetch', 'edit_file', 'apply_patch', 'process', 'another',
    ))).toBe('1 file read, 1 command, 1 web fetch, 5 other operations');
  });

  it('handles unknown names without matching prototype properties', () => {
    expect(toolGroupTitle(tools('custom'))).toBe('1 other operation');
    expect(toolGroupTitle(tools('constructor', 'toString'))).toBe('2 other operations');
  });

  it('does not count non-tools or descendants or depend on execution status', () => {
    const segments = tools('task');
    segments.push({ id: 'text', type: 'text', text: 'child contents' });
    for (const status of ['requested', 'approval', 'running', 'success', 'error']) {
      segments[0].status = status;
      expect(toolGroupTitle(segments)).toBe('1 subagent task');
    }
  });
});
