import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplicationToolPolicy } from './tool-approval-policy.js';
import type { ToolPolicyConfig as ToolsConfig } from '../core/tools/index.js';
import type { SessionPermissionMode } from '../core/approval/index.js';

const empty: ToolsConfig = { allow: [], deny: [] };
const agentHome = resolve('agent-home');

function decide(
  toolName: string,
  config: ToolsConfig,
  hasApprovalCapability: boolean,
  input: Readonly<Record<string, unknown>> = {},
  permissionMode: SessionPermissionMode = 'manual',
) {
  return createApplicationToolPolicy(config, agentHome)
    .decide(toolName, input, hasApprovalCapability, permissionMode);
}

// ── no approval channel (fail-closed) ────────────────────

describe('CH-06 resolveToolPolicy — no approval channel', () => {
  it('denies any tool when allow is empty', () => {
    expect(decide('exec', empty, false)).toBe('deny');
  });

  it('keeps Exec fail-closed even when its name is in the allow list', () => {
    const config: ToolsConfig = { allow: ['exec'], deny: [] };
    expect(decide('exec', config, false)).toBe('deny');
    expect(decide('read_file', config, false)).toBe('deny');
  });

  it('allows tool that matches glob in allow list', () => {
    const config: ToolsConfig = { allow: ['memory_*'], deny: [] };
    expect(decide('memory_search', config, false)).toBe('allow');
    expect(decide('memory_get', config, false)).toBe('allow');
    expect(decide('exec', config, false)).toBe('deny');
  });

  it('deny takes priority over allow even when no channel (behavior reversal vs old)', () => {
    // spec §5.3: deny 优先于 allow，与有 channel 一致。旧实现无 channel 时只看 allow，
    // 现在统一为 deny-first。
    const config: ToolsConfig = { allow: ['exec'], deny: ['exec'] };
    expect(decide('exec', config, false)).toBe('deny');
  });

  it('treats "group:fs" as a literal pattern (group:* removed)', () => {
    // spec §6: group:* 不再展开；当作字面名处理，不匹配任何工具
    const config: ToolsConfig = { allow: ['group:fs'], deny: [] };
    expect(decide('read_file', config, false)).toBe('deny');
    expect(decide('write_file', config, false)).toBe('deny');
    // 只有同名 "group:fs" 工具会命中（虚构例子）
    expect(decide('group:fs', config, false)).toBe('allow');
  });
});

// ── with approval channel ─────────────────────────────────

describe('CH-06 resolveToolPolicy — with approval channel', () => {
  it('prompts when both allow and deny are empty', () => {
    expect(decide('exec', empty, true)).toBe('requires_approval');
  });

  it('deny takes priority over allow', () => {
    const config: ToolsConfig = { allow: ['exec'], deny: ['exec'] };
    expect(decide('exec', config, true)).toBe('deny');
  });

  it('allows tool in allow list (not in deny)', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: [] };
    expect(decide('read_file', config, true)).toBe('allow');
  });

  it('prompts tool not in either list', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: ['exec'] };
    expect(decide('web_fetch', config, true)).toBe('requires_approval');
  });

  it('glob deny matches correctly', () => {
    const config: ToolsConfig = { allow: [], deny: ['memory_*'] };
    expect(decide('memory_search', config, true)).toBe('deny');
    expect(decide('exec', config, true)).toBe('requires_approval');
  });

  it('? glob matches single character', () => {
    const config: ToolsConfig = { allow: ['exec?'], deny: [] };
    expect(decide('execX', config, true)).toBe('allow');
    expect(decide('exec', config, true)).toBe('requires_approval');
    expect(decide('execXY', config, true)).toBe('requires_approval');
  });

  it('reads from ToolsConfig directly', () => {
    const config: ToolsConfig = {
      allow: ['read_file'],
      deny: ['exec'],
    };
    expect(decide('read_file', config, true)).toBe('allow');
    expect(decide('exec', config, true)).toBe('deny');
    expect(decide('web_fetch', config, true)).toBe('requires_approval');
  });

  it('treats "group:fs" as a literal pattern (group:* removed)', () => {
    const config: ToolsConfig = { allow: ['group:fs'], deny: [] };
    // group:fs 不展开 → read_file 不在 allow，走 prompt
    expect(decide('read_file', config, true)).toBe('requires_approval');
  });
});

describe('structured external-path approval', () => {
  const externalPath = resolve(agentHome, '..', 'outside', 'file.txt');

  it('allows an allowed structured Tool for an Agent Home-relative target', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: [] };
    expect(decide('read_file', config, true, { path: 'notes/file.txt' })).toBe('allow');
  });

  describe('Session Allow All', () => {
    it('allows Exec and external structured paths without approval capability', () => {
      const config: ToolsConfig = { allow: [], deny: [] };
      const externalPath = resolve(agentHome, '..', 'outside', 'file.txt');

      expect(decide('exec', config, false, { command: 'npm test' }, 'allow_all')).toBe('allow');
      expect(decide('read_file', config, false, { path: externalPath }, 'allow_all')).toBe('allow');
    });

    it('keeps deny final in Allow All mode', () => {
      const config: ToolsConfig = { allow: ['*'], deny: ['exec'] };

      expect(decide('exec', config, true, { command: 'npm test' }, 'allow_all')).toBe('deny');
      expect(decide('read_file', config, false, { path: 'notes.txt' }, 'allow_all')).toBe('allow');
    });
  });

  it('requires approval for an external target even when the Tool is allowed', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: [] };
    expect(decide('read_file', config, true, { path: externalPath }))
      .toBe('requires_approval');
  });

  it('fails closed for an external target when approval is unavailable', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: [] };
    expect(decide('read_file', config, false, { path: externalPath })).toBe('deny');
  });

  it('keeps Tool-name deny final for external targets', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: ['read_file'] };
    expect(decide('read_file', config, true, { path: externalPath })).toBe('deny');
  });

  it('classifies every apply_patch source and move target', () => {
    const config: ToolsConfig = { allow: ['apply_patch'], deny: [] };
    const input = {
      input: [
        '*** Begin Patch',
        '*** Update File: notes.txt',
        `*** Move to: ${externalPath}`,
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n'),
    };
    expect(decide('apply_patch', config, true, input)).toBe('requires_approval');
  });

  it('treats omitted Search path as the internal Agent Home default', () => {
    const config: ToolsConfig = { allow: ['file_search', 'grep_search'], deny: [] };
    expect(decide('file_search', config, true, { query: '*.ts' })).toBe('allow');
    expect(decide('grep_search', config, true, { query: 'x', isRegexp: false })).toBe('allow');
  });

  it('requires approval for Exec without inferring effects from cwd or command text', () => {
    const config: ToolsConfig = { allow: ['exec'], deny: [] };
    expect(decide('exec', config, true, {
      command: `remove ${externalPath}`,
      cwd: externalPath,
    })).toBe('requires_approval');
  });
});
