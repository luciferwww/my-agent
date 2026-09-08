import { describe, expect, it } from 'vitest';
import { createApplicationToolPolicy } from './tool-approval-policy.js';
import type { ToolsConfig } from '../platform/config/types.js';

const empty: ToolsConfig = { allow: [], deny: [] };

function decide(toolName: string, config: ToolsConfig, hasApprovalCapability: boolean) {
  return createApplicationToolPolicy(config).decide(toolName, hasApprovalCapability);
}

// ── no approval channel (fail-closed) ────────────────────

describe('CH-06 resolveToolPolicy — no approval channel', () => {
  it('denies any tool when allow is empty', () => {
    expect(decide('exec', empty, false)).toBe('deny');
  });

  it('allows tool that matches exact name in allow list', () => {
    const config: ToolsConfig = { allow: ['exec'], deny: [] };
    expect(decide('exec', config, false)).toBe('allow');
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

  it('reads from ToolsConfig directly (with fs / no approval nesting)', () => {
    // ToolsConfig 完整对象——验证类型兼容
    const config: ToolsConfig = {
      fs: { workspaceOnly: true },
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
