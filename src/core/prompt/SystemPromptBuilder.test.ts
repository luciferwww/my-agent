import { describe, it, expect, vi } from 'vitest';
import { SystemPromptBuilder } from './SystemPromptBuilder.js';

describe('SystemPromptBuilder', () => {

  // ── 模式控制 ──────────────────────────────────────────────

  describe('mode', () => {
    it('defaults to full mode', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).toContain('# Identity');
      expect(prompt).toContain('# Behavior Rules');
      expect(prompt).toContain('# Safety');
    });

    it('full mode includes all sections', () => {
      const prompt = new SystemPromptBuilder().build({ mode: 'full' });
      expect(prompt).toContain('# Identity');
      expect(prompt).toContain('# Current Date & Time');
      expect(prompt).toContain('# Behavior Rules');
      expect(prompt).toContain('# Safety');
    });

    it('minimal mode skips memory-instructions', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        tools: [{ name: 'memory_search', description: 'search' }],
      });
      expect(prompt).not.toContain('# Memory Recall');
    });

    it('minimal mode skips identity / behavior-rules / memory / available-subagents (spec §11)', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        tools: [{ name: 'memory_search', description: 'search' }],
        contextFiles: [{ path: 'IDENTITY.md', content: '# test' }],
        availableSubagents: [{ id: 'a', description: 'desc' }],
      });
      expect(prompt).not.toContain('# Identity');
      expect(prompt).not.toContain('# Behavior Rules');
      expect(prompt).not.toContain('# Memory Recall');
      expect(prompt).not.toContain('<available-subagents>');
    });

    it('minimal mode keeps datetime / safety / project-context / workspace', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        contextFiles: [{ path: 'IDENTITY.md', content: '# test' }],
        workspaceDir: '/work',
      });
      expect(prompt).toContain('# Current Date & Time');
      // tool-definitions section is disabled; tools are passed via LLM API
      expect(prompt).not.toContain('# Available Tools');
      expect(prompt).toContain('# Safety');
      expect(prompt).toContain('# Project Context');
      expect(prompt).toContain('# Workspace');
      expect(prompt).toContain('Your working directory is: /work');
    });

    it('none mode returns empty string', () => {
      const prompt = new SystemPromptBuilder().build({ mode: 'none' });
      expect(prompt).toBe('');
    });
  });

  // ── agent-identity ────────────────────────────────────────

  describe('agent-identity', () => {
    it('includes fixed identity statement', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).toContain('You are an AI assistant.');
    });
  });

  // ── agent-datetime ────────────────────────────────────────

  describe('agent-datetime', () => {
    it('includes current date and time', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).toContain('# Current Date & Time');
      // Should contain current year
      expect(prompt).toContain(String(new Date().getFullYear()));
    });
  });

  // ── tool-definitions ──────────────────────────────────────
  //
  // 该 section 已在 SystemPromptBuilder 中停用（buildToolDefinitionsSection
  // 被注释掉）。工具定义现由 LLM API 的 `tools` 参数传递，在 system
  // prompt 里重复列为冗余。原有测试（断言 # Available Tools 出现 /
  // **search_web** 等）随代码一同移除。

  // ── behavior-rules ────────────────────────────────────────

  describe('behavior-rules', () => {
    it('includes behavior rules and tool usage rules', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).toContain('# Behavior Rules');
      expect(prompt).toContain('Be concise and direct');
      expect(prompt).toContain('Only call a tool when it is clearly necessary');
    });
  });

  // ── safety-constraints ────────────────────────────────────

  describe('safety-constraints', () => {
    it('includes normal safety by default', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).toContain('# Safety');
      expect(prompt).toContain('Act within the scope');
    });

    it('includes strict safety when safetyLevel is strict', () => {
      const prompt = new SystemPromptBuilder().build({ safetyLevel: 'strict' });
      expect(prompt).toContain('# Safety');
      expect(prompt).toContain('no independent goals');
    });

    it('skips safety section when safetyLevel is relaxed', () => {
      const prompt = new SystemPromptBuilder().build({ safetyLevel: 'relaxed' });
      expect(prompt).not.toContain('# Safety');
    });
  });

  // ── memory-instructions ───────────────────────────────────

  describe('memory-instructions', () => {
    it('shows when tools contain memory_search', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [{ name: 'memory_search', description: 'search' }],
      });
      expect(prompt).toContain('# Memory Recall');
    });

    it('keeps legacy compatibility for search_memory', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [{ name: 'search_memory', description: 'search' }],
      });
      expect(prompt).toContain('# Memory Recall');
    });

    it('shows when tools contain memory_get', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [{ name: 'memory_get', description: 'get' }],
      });
      expect(prompt).toContain('# Memory Recall');
    });

    it('skips when no memory tools', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [{ name: 'read_file', description: 'read' }],
      });
      expect(prompt).not.toContain('# Memory Recall');
    });

    it('skips when no tools at all', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).not.toContain('# Memory Recall');
    });

    it('skips in minimal mode even with memory tools', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        tools: [{ name: 'memory_search', description: 'search' }],
      });
      expect(prompt).not.toContain('# Memory Recall');
    });
  });

  // ── project-context ───────────────────────────────────────

  describe('project-context', () => {
    it('injects context files', () => {
      const prompt = new SystemPromptBuilder().build({
        contextFiles: [
          { path: 'IDENTITY.md', content: '- **Name:** Aria' },
          { path: 'AGENTS.md', content: '# Agents rules' },
        ],
      });
      expect(prompt).toContain('# Project Context');
      expect(prompt).toContain('## IDENTITY.md');
      expect(prompt).toContain('- **Name:** Aria');
      expect(prompt).toContain('## AGENTS.md');
    });

    it('skips when no contextFiles', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).not.toContain('# Project Context');
    });

    it('skips when contextFiles is empty', () => {
      const prompt = new SystemPromptBuilder().build({ contextFiles: [] });
      expect(prompt).not.toContain('# Project Context');
    });

    it('adds SOUL.md persona hint when SOUL.md is present', () => {
      const prompt = new SystemPromptBuilder().build({
        contextFiles: [
          { path: 'SOUL.md', content: 'Be direct and concise.' },
        ],
      });
      expect(prompt).toContain('embody its persona and tone');
    });

    it('does not add persona hint when no SOUL.md', () => {
      const prompt = new SystemPromptBuilder().build({
        contextFiles: [
          { path: 'IDENTITY.md', content: '- **Name:** Aria' },
        ],
      });
      expect(prompt).not.toContain('embody its persona and tone');
    });

    it('skips files with empty content', () => {
      const prompt = new SystemPromptBuilder().build({
        contextFiles: [
          { path: 'IDENTITY.md', content: '- **Name:** Aria' },
          { path: 'EMPTY.md', content: '   ' },
        ],
      });
      expect(prompt).toContain('## IDENTITY.md');
      expect(prompt).not.toContain('## EMPTY.md');
    });
  });

  // ── workspace (Section 7) ────────────────────────────────

  describe('workspace section (Section 7)', () => {
    it('renders "# Workspace" with workingDir when workspaceDir is set', () => {
      const prompt = new SystemPromptBuilder().build({ workspaceDir: '/work/space' });
      expect(prompt).toContain('# Workspace');
      expect(prompt).toContain('Your working directory is: /work/space');
    });

    it('renders workspace section in minimal mode too', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        workspaceDir: '/work/space',
      });
      expect(prompt).toContain('# Workspace');
    });

    it('skips workspace section when workspaceDir is not provided', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).not.toContain('# Workspace');
    });

    it('returns empty string in none mode regardless of workspaceDir', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'none',
        workspaceDir: '/work/space',
      });
      expect(prompt).toBe('');
    });
  });

  // ── available-subagents (Section 8) ──────────────────────

  describe('available-subagents section (Section 8)', () => {
    it('renders <available-subagents> block in full mode when entries provided', () => {
      const prompt = new SystemPromptBuilder().build({
        availableSubagents: [
          { id: 'general-purpose', description: 'fallback' },
          { id: 'reviewer', description: 'reviews code' },
        ],
      });
      expect(prompt).toContain('<available-subagents>');
      expect(prompt).toContain('- general-purpose: fallback');
      expect(prompt).toContain('- reviewer: reviews code');
      expect(prompt).toContain('</available-subagents>');
    });

    it('skips the section when entries array is empty', () => {
      const prompt = new SystemPromptBuilder().build({ availableSubagents: [] });
      expect(prompt).not.toContain('<available-subagents>');
    });

    it('skips the section when availableSubagents is undefined', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).not.toContain('<available-subagents>');
    });

    it('skips the section in minimal mode even when entries are provided', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        availableSubagents: [{ id: 'reviewer', description: 'reviews' }],
      });
      expect(prompt).not.toContain('<available-subagents>');
    });
  });
});
