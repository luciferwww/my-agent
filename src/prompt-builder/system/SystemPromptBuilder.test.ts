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
        tools: [{ name: 'search_memory', description: 'search' }],
      });
      expect(prompt).toContain('# Identity');
      expect(prompt).not.toContain('# Memory Recall');
    });

    it('minimal mode keeps identity, datetime, tools, behavior, safety, output, project-context', () => {
      const prompt = new SystemPromptBuilder().build({
        mode: 'minimal',
        tools: [{ name: 'read_file', description: 'read' }],
        contextFiles: [{ path: 'IDENTITY.md', content: '# test' }],
      });
      expect(prompt).toContain('# Identity');
      expect(prompt).toContain('# Current Date & Time');
      expect(prompt).toContain('# Available Tools');
      expect(prompt).toContain('# Behavior Rules');
      expect(prompt).toContain('# Safety');
      expect(prompt).toContain('# Project Context');
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

  describe('tool-definitions', () => {
    it('lists tools with descriptions when provided', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [
          { name: 'search_web', description: 'Search the internet' },
          { name: 'read_file', description: 'Read file contents' },
        ],
      });
      expect(prompt).toContain('# Available Tools');
      expect(prompt).toContain('**search_web**');
      expect(prompt).toContain('Search the internet');
      expect(prompt).toContain('**read_file**');
    });

    it('skips section when no tools provided', () => {
      const prompt = new SystemPromptBuilder().build();
      expect(prompt).not.toContain('# Available Tools');
    });

    it('skips section when tools is empty array', () => {
      const prompt = new SystemPromptBuilder().build({ tools: [] });
      expect(prompt).not.toContain('# Available Tools');
    });
  });

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
    it('shows when tools contain search_memory', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [{ name: 'search_memory', description: 'search' }],
      });
      expect(prompt).toContain('# Memory Recall');
    });

    it('shows when tools contain memory_search', () => {
      const prompt = new SystemPromptBuilder().build({
        tools: [{ name: 'memory_search', description: 'search' }],
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
        tools: [{ name: 'search_memory', description: 'search' }],
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
});
