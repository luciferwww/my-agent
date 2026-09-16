import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadContextFiles, loadContextFilesFromDir } from './loader.js';

describe('loadContextFiles', () => {
  let agentHome: string;
  let agentContextDir: string;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'loader-test-'));
    agentContextDir = agentHome;
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  // ── 基本加载 ──────────────────────────────────────────────

  describe('basic loading', () => {
    it('loads all 4 files in correct order', async () => {
      await writeFile(join(agentContextDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentContextDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentContextDir, 'AGENTS.md'), '# Agents', 'utf-8');
      await writeFile(join(agentContextDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(agentHome);

      expect(files).toHaveLength(4);
      expect(files[0]!.path).toBe('IDENTITY.md');
      expect(files[1]!.path).toBe('SOUL.md');
      expect(files[2]!.path).toBe('AGENTS.md');
      expect(files[3]!.path).toBe('TOOLS.md');
    });

    it('skips missing files without error', async () => {
      await writeFile(join(agentContextDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentContextDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(agentHome);

      expect(files).toHaveLength(2);
      expect(files[0]!.path).toBe('SOUL.md');
      expect(files[1]!.path).toBe('TOOLS.md');
    });

    it('returns empty array when all files are missing', async () => {
      const files = await loadContextFiles(agentHome);
      expect(files).toHaveLength(0);
    });

    it('skips empty files', async () => {
      await writeFile(join(agentContextDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentContextDir, 'SOUL.md'), '   \n\n  ', 'utf-8'); // only whitespace
      await writeFile(join(agentContextDir, 'AGENTS.md'), '', 'utf-8'); // empty

      const files = await loadContextFiles(agentHome);

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe('IDENTITY.md');
    });
  });

  // ── mode 过滤 ─────────────────────────────────────────────

  describe('mode filtering', () => {
    it('mode full loads all 4 files', async () => {
      await writeFile(join(agentContextDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentContextDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentContextDir, 'AGENTS.md'), '# Agents', 'utf-8');
      await writeFile(join(agentContextDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(agentHome, { mode: 'full' });
      expect(files).toHaveLength(4);
    });

    it('mode minimal loads only identity and soul files', async () => {
      await writeFile(join(agentContextDir, 'IDENTITY.md'), '# Identity', 'utf-8');
      await writeFile(join(agentContextDir, 'SOUL.md'), '# Soul', 'utf-8');
      await writeFile(join(agentContextDir, 'AGENTS.md'), '# Agents', 'utf-8');
      await writeFile(join(agentContextDir, 'TOOLS.md'), '# Tools', 'utf-8');

      const files = await loadContextFiles(agentHome, { mode: 'minimal' });
      expect(files).toHaveLength(2);
      expect(files[0]!.path).toBe('IDENTITY.md');
      expect(files[1]!.path).toBe('SOUL.md');
    });
  });

  // ── 单文件截断 ────────────────────────────────────────────

  describe('single file truncation', () => {
    it('does not truncate file within limit', async () => {
      const content = 'A'.repeat(100);
      await writeFile(join(agentContextDir, 'IDENTITY.md'), content, 'utf-8');

      const files = await loadContextFiles(agentHome, { maxFileChars: 200 });

      expect(files[0]!.content).toBe(content);
    });

    it('truncates file exceeding maxFileChars with head + tail + marker', async () => {
      const content = 'A'.repeat(1000);
      const warn = vi.fn();

      const files = await loadContextFiles(agentHome, {
        maxFileChars: 200,
        warn,
      });

      await writeFile(join(agentContextDir, 'IDENTITY.md'), content, 'utf-8');
      const result = await loadContextFiles(agentHome, {
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

      await writeFile(join(agentContextDir, 'IDENTITY.md'), content, 'utf-8');

      const files = await loadContextFiles(agentHome, {
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
      await writeFile(join(agentContextDir, 'IDENTITY.md'), 'A'.repeat(100), 'utf-8');
      await writeFile(join(agentContextDir, 'SOUL.md'), 'B'.repeat(100), 'utf-8');
      await writeFile(join(agentContextDir, 'AGENTS.md'), 'C'.repeat(100), 'utf-8');
      await writeFile(join(agentContextDir, 'TOOLS.md'), 'D'.repeat(100), 'utf-8');

      const files = await loadContextFiles(agentHome, {
        maxTotalChars: 250,
        warn: () => {},
      });

      // Should load first 2 files (200 chars), then third partially or fully
      expect(files.length).toBeLessThanOrEqual(3);
      const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
      expect(totalChars).toBeLessThanOrEqual(250);
    });

    it('skips remaining files when budget < 64 chars', async () => {
      await writeFile(join(agentContextDir, 'IDENTITY.md'), 'A'.repeat(200), 'utf-8');
      await writeFile(join(agentContextDir, 'SOUL.md'), 'B'.repeat(50), 'utf-8');
      const warn = vi.fn();

      const files = await loadContextFiles(agentHome, {
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
      await writeFile(join(agentContextDir, 'IDENTITY.md'), content, 'utf-8');

      const warn = vi.fn();
      await loadContextFiles(agentHome, { maxFileChars: 100, warn });

      expect(warn).toHaveBeenCalled();
    });

    it('does not call warn when no truncation needed', async () => {
      await writeFile(join(agentContextDir, 'IDENTITY.md'), '# Identity', 'utf-8');

      const warn = vi.fn();
      await loadContextFiles(agentHome, { warn });

      expect(warn).not.toHaveBeenCalled();
    });
  });
});

// ── loadContextFilesFromDir ───────────────────────────────────

describe('loadContextFilesFromDir', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'loader-fromdir-test-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('reads files directly from the supplied absolute directory', async () => {
    await writeFile(join(baseDir, 'IDENTITY.md'), '# Identity', 'utf-8');
    await writeFile(join(baseDir, 'SOUL.md'), '# Soul', 'utf-8');

    const files = await loadContextFilesFromDir(baseDir);

    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe('IDENTITY.md');
    expect(files[0]!.content).toBe('# Identity');
    expect(files[1]!.path).toBe('SOUL.md');
  });

  it('does not read from an obsolete nested .agent directory', async () => {
    const stowed = join(baseDir, '.agent');
    await mkdir(stowed, { recursive: true });
    await writeFile(join(stowed, 'IDENTITY.md'), '# Identity (stowed)', 'utf-8');

    const files = await loadContextFilesFromDir(baseDir);
    expect(files).toHaveLength(0);
  });

  it('skips missing files without error', async () => {
    await writeFile(join(baseDir, 'SOUL.md'), '# Soul', 'utf-8');

    const files = await loadContextFilesFromDir(baseDir);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('SOUL.md');
  });

  it('respects mode=minimal filter', async () => {
    await writeFile(join(baseDir, 'IDENTITY.md'), '# Identity', 'utf-8');
    await writeFile(join(baseDir, 'SOUL.md'), '# Soul', 'utf-8');
    await writeFile(join(baseDir, 'AGENTS.md'), '# Agents', 'utf-8');
    await writeFile(join(baseDir, 'TOOLS.md'), '# Tools', 'utf-8');

    const files = await loadContextFilesFromDir(baseDir, { mode: 'minimal' });
    expect(files.map((f) => f.path)).toEqual(['IDENTITY.md', 'SOUL.md']);
  });

  it('truncates files exceeding maxFileChars', async () => {
    const content = 'A'.repeat(1000);
    await writeFile(join(baseDir, 'IDENTITY.md'), content, 'utf-8');
    const warn = vi.fn();

    const files = await loadContextFilesFromDir(baseDir, { maxFileChars: 200, warn });

    expect(files[0]!.content).toContain('[...truncated');
    expect(files[0]!.content.length).toBeLessThan(content.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IDENTITY.md is 1000 chars'));
  });

  it('returns empty array for missing directory', async () => {
    const missing = join(baseDir, 'does-not-exist');
    const files = await loadContextFilesFromDir(missing);
    expect(files).toHaveLength(0);
  });
});