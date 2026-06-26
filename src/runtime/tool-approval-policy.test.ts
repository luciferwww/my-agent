import { describe, expect, it } from 'vitest';
import { resolveToolPolicy } from './tool-approval-policy.js';
import type { ToolsConfig } from '../platform/config/types.js';

const empty: ToolsConfig = { allow: [], deny: [] };

// ── no approval channel (fail-closed) ────────────────────

describe('resolveToolPolicy — no approval channel', () => {
  it('denies any tool when allow is empty', () => {
    expect(resolveToolPolicy('exec', empty, false)).toBe('deny');
  });

  it('allows tool that matches exact name in allow list', () => {
    const config: ToolsConfig = { allow: ['exec'], deny: [] };
    expect(resolveToolPolicy('exec', config, false)).toBe('allow');
    expect(resolveToolPolicy('read_file', config, false)).toBe('deny');
  });

  it('allows tool that matches glob in allow list', () => {
    const config: ToolsConfig = { allow: ['memory_*'], deny: [] };
    expect(resolveToolPolicy('memory_search', config, false)).toBe('allow');
    expect(resolveToolPolicy('memory_get', config, false)).toBe('allow');
    expect(resolveToolPolicy('exec', config, false)).toBe('deny');
  });

  it('deny takes priority over allow even when no channel (behavior reversal vs old)', () => {
    // spec §5.3: deny 优先于 allow，与有 channel 一致。旧实现无 channel 时只看 allow，
    // 现在统一为 deny-first。
    const config: ToolsConfig = { allow: ['exec'], deny: ['exec'] };
    expect(resolveToolPolicy('exec', config, false)).toBe('deny');
  });

  it('treats "group:fs" as a literal pattern (group:* removed)', () => {
    // spec §6: group:* 不再展开；当作字面名处理，不匹配任何工具
    const config: ToolsConfig = { allow: ['group:fs'], deny: [] };
    expect(resolveToolPolicy('read_file', config, false)).toBe('deny');
    expect(resolveToolPolicy('write_file', config, false)).toBe('deny');
    // 只有同名 "group:fs" 工具会命中（虚构例子）
    expect(resolveToolPolicy('group:fs', config, false)).toBe('allow');
  });
});

// ── with approval channel ─────────────────────────────────

describe('resolveToolPolicy — with approval channel', () => {
  it('prompts when both allow and deny are empty', () => {
    expect(resolveToolPolicy('exec', empty, true)).toBe('prompt');
  });

  it('deny takes priority over allow', () => {
    const config: ToolsConfig = { allow: ['exec'], deny: ['exec'] };
    expect(resolveToolPolicy('exec', config, true)).toBe('deny');
  });

  it('allows tool in allow list (not in deny)', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: [] };
    expect(resolveToolPolicy('read_file', config, true)).toBe('allow');
  });

  it('prompts tool not in either list', () => {
    const config: ToolsConfig = { allow: ['read_file'], deny: ['exec'] };
    expect(resolveToolPolicy('web_fetch', config, true)).toBe('prompt');
  });

  it('glob deny matches correctly', () => {
    const config: ToolsConfig = { allow: [], deny: ['memory_*'] };
    expect(resolveToolPolicy('memory_search', config, true)).toBe('deny');
    expect(resolveToolPolicy('exec', config, true)).toBe('prompt');
  });

  it('? glob matches single character', () => {
    const config: ToolsConfig = { allow: ['exec?'], deny: [] };
    expect(resolveToolPolicy('execX', config, true)).toBe('allow');
    expect(resolveToolPolicy('exec', config, true)).toBe('prompt');
    expect(resolveToolPolicy('execXY', config, true)).toBe('prompt');
  });

  it('reads from ToolsConfig directly (with fs / no approval nesting)', () => {
    // ToolsConfig 完整对象——验证类型兼容
    const config: ToolsConfig = {
      fs: { workspaceOnly: true },
      allow: ['read_file'],
      deny: ['exec'],
    };
    expect(resolveToolPolicy('read_file', config, true)).toBe('allow');
    expect(resolveToolPolicy('exec', config, true)).toBe('deny');
    expect(resolveToolPolicy('web_fetch', config, true)).toBe('prompt');
  });

  it('treats "group:fs" as a literal pattern (group:* removed)', () => {
    const config: ToolsConfig = { allow: ['group:fs'], deny: [] };
    // group:fs 不展开 → read_file 不在 allow，走 prompt
    expect(resolveToolPolicy('read_file', config, true)).toBe('prompt');
  });
});
