import { describe, expect, it } from 'vitest';
import { resolveToolApprovalAction } from './tool-approval-policy.js';
import type { ToolApprovalConfig } from '../platform/config/types.js';

const empty: ToolApprovalConfig = { allow: [], deny: [] };

// ── no approval channel (fail-closed) ────────────────────

describe('resolveToolApprovalAction — no approval channel', () => {
  it('denies any tool when allow is empty', () => {
    expect(resolveToolApprovalAction('exec', empty, false)).toBe('deny');
  });

  it('allows tool that matches exact name in allow list', () => {
    const config: ToolApprovalConfig = { allow: ['exec'], deny: [] };
    expect(resolveToolApprovalAction('exec', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('read_file', config, false)).toBe('deny');
  });

  it('allows tool that matches glob in allow list', () => {
    const config: ToolApprovalConfig = { allow: ['memory_*'], deny: [] };
    expect(resolveToolApprovalAction('memory_search', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('memory_get', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('exec', config, false)).toBe('deny');
  });

  it('allows tools in group:fs', () => {
    const config: ToolApprovalConfig = { allow: ['group:fs'], deny: [] };
    expect(resolveToolApprovalAction('read_file', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('write_file', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('edit_file', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('apply_patch', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('list_dir', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('exec', config, false)).toBe('deny');
  });

  it('allows tools in group:exec', () => {
    const config: ToolApprovalConfig = { allow: ['group:exec'], deny: [] };
    expect(resolveToolApprovalAction('exec', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('process', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('read_file', config, false)).toBe('deny');
  });

  it('allows tools in group:search', () => {
    const config: ToolApprovalConfig = { allow: ['group:search'], deny: [] };
    expect(resolveToolApprovalAction('grep_search', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('file_search', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('exec', config, false)).toBe('deny');
  });

  it('allows tools in group:memory', () => {
    const config: ToolApprovalConfig = { allow: ['group:memory'], deny: [] };
    expect(resolveToolApprovalAction('memory_search', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('memory_get', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('memory_write', config, false)).toBe('allow');
    expect(resolveToolApprovalAction('exec', config, false)).toBe('deny');
  });

  it('deny list is ignored when no channel', () => {
    // In fail-closed mode, the deny list has no effect; only allow matters
    const config: ToolApprovalConfig = { allow: ['exec'], deny: ['exec'] };
    // deny is irrelevant — allow wins if present (allow checked first in no-channel path)
    expect(resolveToolApprovalAction('exec', config, false)).toBe('allow');
  });
});

// ── with approval channel ─────────────────────────────────

describe('resolveToolApprovalAction — with approval channel', () => {
  it('prompts when both allow and deny are empty', () => {
    expect(resolveToolApprovalAction('exec', empty, true)).toBe('prompt');
  });

  it('deny takes priority over allow', () => {
    const config: ToolApprovalConfig = { allow: ['exec'], deny: ['exec'] };
    expect(resolveToolApprovalAction('exec', config, true)).toBe('deny');
  });

  it('allows tool in allow list (not in deny)', () => {
    const config: ToolApprovalConfig = { allow: ['read_file'], deny: [] };
    expect(resolveToolApprovalAction('read_file', config, true)).toBe('allow');
  });

  it('prompts tool not in either list', () => {
    const config: ToolApprovalConfig = { allow: ['read_file'], deny: ['exec'] };
    expect(resolveToolApprovalAction('web_fetch', config, true)).toBe('prompt');
  });

  it('deny via group:exec, allow via group:fs, prompt for other', () => {
    const config: ToolApprovalConfig = { allow: ['group:fs'], deny: ['group:exec'] };
    expect(resolveToolApprovalAction('exec', config, true)).toBe('deny');
    expect(resolveToolApprovalAction('read_file', config, true)).toBe('allow');
    expect(resolveToolApprovalAction('web_fetch', config, true)).toBe('prompt');
  });

  it('glob deny matches correctly', () => {
    const config: ToolApprovalConfig = { allow: [], deny: ['memory_*'] };
    expect(resolveToolApprovalAction('memory_search', config, true)).toBe('deny');
    expect(resolveToolApprovalAction('exec', config, true)).toBe('prompt');
  });

  it('? glob matches single character', () => {
    const config: ToolApprovalConfig = { allow: ['exec?'], deny: [] };
    expect(resolveToolApprovalAction('execX', config, true)).toBe('allow');
    expect(resolveToolApprovalAction('exec', config, true)).toBe('prompt');
    expect(resolveToolApprovalAction('execXY', config, true)).toBe('prompt');
  });
});
