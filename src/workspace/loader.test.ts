import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadContextFiles } from './loader.js';

describe('loadContextFiles', () => {
  let workspaceDir: string;
  let agentDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'loader-test-'));
    agentDir = join(workspaceDir, '.agent');
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  // ── 基本加载 ──────────────────────────────────────────────

  describe('basic loading', () => {
    it('loads all 4 files in correct order', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentDir, 'AGENTS.md'), '# Agents', 'utf-8');
      await writeFile(join(agentDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(workspaceDir);

      expect(files).toHaveLength(4);
      expect(files[0]!.path).toBe('IDENTITY.md');
      expect(files[1]!.path).toBe('SOUL.md');
      expect(files[2]!.path).toBe('AGENTS.md');
      expect(files[3]!.path).toBe('TOOLS.md');
    });

    it('skips missing files without error', async () => {
      await writeFile(join(agentDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(workspaceDir);

      expect(files).toHaveLength(2);
      expect(files[0]!.path).toBe('SOUL.md');
      expect(files[1]!.path).toBe('TOOLS.md');
    });

    it('returns empty array when all files are missing', async () => {
      const files = await loadContextFiles(workspaceDir);
      expect(files).toHaveLength(0);
    });

    it('skips empty files', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentDir, 'SOUL.md'), '   \n\n  ', 'utf-8'); // only whitespace
      await writeFile(join(agentDir, 'AGENTS.md'), '', 'utf-8'); // empty

      const files = await loadContextFiles(workspaceDir);

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe('IDENTITY.md');
    });
  });

  // ── mode 过滤 ─────────────────────────────────────────────

  describe('mode filtering', () => {
    it('mode full loads all 4 files', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentDir, 'AGENTS.md'), '# Agents', 'utf-8');
      await writeFile(join(agentDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(workspaceDir, { mode: 'full' });
      expect(files).toHaveLength(4);
    });

    it('mode minimal currently loads all 4 files (same as full)', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentDir, 'AGENTS.md'), '# Agents', 'utf-8');
      await writeFile(join(agentDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(workspaceDir, { mode: 'minimal' });
      expect(files).toHaveLength(4);
    });
  });

  // ── 单文件截断 ────────────────────────────────────────────

  describe('single file truncation', () => {
    it('does not truncate file within limit', async () => {
      const content = 'A'.repeat(100);
      await writeFile(join(agentDir, 'IDENTITY.md'), content, 'utf-8');

      const files = await loadContextFiles(workspaceDir, { maxFileChars: 200 });

      expect(files[0]!.content).toBe(content);
    });

    it('truncates file exceeding maxFileChars with head + tail + marker', async () => {
      const content = 'A'.repeat(1000);
      const warn = vi.fn();

      const files = await loadContextFiles(workspaceDir, {
        maxFileChars: 200,
        warn,
      });

      await writeFile(join(agentDir, 'IDENTITY.md'), content, 'utf-8');
      const result = await loadContextFiles(workspaceDir, {
        maxFileChars: 200,
        warn,
      });

      const file = result[0]!;
      expect(file.content).toContain('[...truncated, read IDENTITY.md for full content...]');
      expect(file.content.length).toBeLessThan(content.length);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('IDENTITY.md is 1000 chars'),
      );
    });

    it('truncated content preserves head (70%) and tail (20%)', async () => {
      // Create content with identifiable head and tail
      const head = 'HEAD'.repeat(50); // 200 chars
      const middle = 'MIDDLE'.repeat(50); // 300 chars
      const tail = 'TAIL'.repeat(50); // 200 chars
      const content = head + middle + tail;

      await writeFile(join(agentDir, 'IDENTITY.md'), content, 'utf-8');

      const files = await loadContextFiles(workspaceDir, {
        maxFileChars: 300,
        warn: () => {},
      });

      const result = files[0]!.content;
      // Head portion should be preserved
      expect(result.startsWith('HEAD')).toBe(true);
      // Tail portion should be preserved
      expect(result.endsWith('TAIL')).toBe(true);
      // Truncation marker should be present
      expect(result).toContain('[...truncated');
    });
  });

  // ── 总量预算 ──────────────────────────────────────────────

  describe('total budget', () => {
    it('stops loading when total budget is exceeded', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), 'A'.repeat(100), 'utf-8');
      await writeFile(join(agentDir, 'SOUL.md'), 'B'.repeat(100), 'utf-8');
      await writeFile(join(agentDir, 'AGENTS.md'), 'C'.repeat(100), 'utf-8');
      await writeFile(join(agentDir, 'TOOLS.md'), 'D'.repeat(100), 'utf-8');

      const files = await loadContextFiles(workspaceDir, {
        maxTotalChars: 250,
        warn: () => {},
      });

      // Should load first 2 files (200 chars), then third partially or fully
      expect(files.length).toBeLessThanOrEqual(3);
      const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
      expect(totalChars).toBeLessThanOrEqual(250);
    });

    it('skips remaining files when budget < 64 chars', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), 'A'.repeat(200), 'utf-8');
      await writeFile(join(agentDir, 'SOUL.md'), 'B'.repeat(50), 'utf-8');
      const warn = vi.fn();

      const files = await loadContextFiles(workspaceDir, {
        maxTotalChars: 230,
        warn,
      });

      // First file uses 200, leaving 30 < 64 → skip SOUL.md
      expect(files).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('<64'),
      );
    });
  });

  // ── warn 回调 ─────────────────────────────────────────────

  describe('warn callback', () => {
    it('uses custom warn callback instead of console.warn', async () => {
      const content = 'A'.repeat(500);
      await writeFile(join(agentDir, 'IDENTITY.md'), content, 'utf-8');

      const warn = vi.fn();
      await loadContextFiles(workspaceDir, { maxFileChars: 100, warn });

      expect(warn).toHaveBeenCalled();
    });

    it('does not call warn when no truncation needed', async () => {
      await writeFile(join(agentDir, 'IDENTITY.md'), '# Identity', 'utf-8');

      const warn = vi.fn();
      await loadContextFiles(workspaceDir, { warn });

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
