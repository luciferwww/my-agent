import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ContextFile } from './types.js';

/** .agent 子目录名称 */
const AGENT_DIR = '.agent';

/** 所有支持的上下文文件，按固定顺序 */
const ALL_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'TOOLS.md',
] as const;

/**
 * 截断策略的常量。
 * 参考 OpenClaw 的 bootstrap.ts：
 *   BOOTSTRAP_HEAD_RATIO = 0.7
 *   BOOTSTRAP_TAIL_RATIO = 0.2
 *   MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64
 */
const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;
const MIN_FILE_BUDGET_CHARS = 64;

/** 默认单文件最大字符数（与 OpenClaw 的 DEFAULT_BOOTSTRAP_MAX_CHARS 一致） */
const DEFAULT_MAX_FILE_CHARS = 20_000;

/** 默认所有文件总最大字符数（与 OpenClaw 的 DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS 一致） */
const DEFAULT_MAX_TOTAL_CHARS = 150_000;

/**
 * 截断文件内容，保留前 70% + 后 20%，中间插入截断标记。
 * 参考 OpenClaw 的 trimBootstrapContent()。
 */
function truncateContent(content: string, fileName: string, maxChars: number): {
  content: string;
  truncated: boolean;
  originalLength: number;
} {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return { content: trimmed, truncated: false, originalLength: trimmed.length };
  }

  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.floor(maxChars * TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker = [
    '',
    `[...truncated, read ${fileName} for full content...]`,
    `...(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})...`,
    '',
  ].join('\n');

  return {
    content: [head, marker, tail].join('\n'),
    truncated: true,
    originalLength: trimmed.length,
  };
}

export interface LoadContextFilesOptions {
  /** 加载模式，默认 'full'。当前 full 和 minimal 加载相同文件，预留未来扩展。 */
  mode?: 'full' | 'minimal';
  /** 单文件最大字符数，默认 20,000（与 OpenClaw 一致） */
  maxFileChars?: number;
  /** 所有文件总最大字符数，默认 150,000（与 OpenClaw 一致） */
  maxTotalChars?: number;
  /** 警告回调，默认 console.warn。截断或跳过文件时调用。 */
  warn?: (message: string) => void;
}

/**
 * 从工作目录的 .agent/ 子目录读取上下文文件，返回 ContextFile[]。
 *
 * 行为规则：
 * - 按固定顺序读取：IDENTITY.md → SOUL.md → AGENTS.md → TOOLS.md
 * - 文件不存在 → 跳过（不报错）
 * - 文件为空（trim 后） → 跳过
 * - 文件超出 maxFileChars → 截断（前 70% + 后 20% + 截断标记）+ warn
 * - 累计超出 maxTotalChars → 截断当前文件或跳过后续文件 + warn
 * - 剩余预算 < 64 字符 → 跳过后续文件 + warn
 *
 * 参考 OpenClaw 的 buildBootstrapContextFiles()（src/agents/pi-embedded-helpers/bootstrap.ts）。
 *
 * @param workspaceDir - 工作区根目录路径
 * @param opts - 可选配置
 */
export async function loadContextFiles(
  workspaceDir: string,
  opts?: LoadContextFilesOptions,
): Promise<ContextFile[]> {
  const maxFileChars = opts?.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const maxTotalChars = Math.max(1, opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
  const warn = opts?.warn ?? console.warn;

  const agentDir = join(workspaceDir, AGENT_DIR);
  const results: ContextFile[] = [];
  let remainingTotalChars = maxTotalChars;

  for (const name of ALL_FILES) {
    // 总预算已用完
    if (remainingTotalChars <= 0) {
      break;
    }

    // 剩余预算太少，跳过后续文件（参考 OpenClaw 的 MIN_BOOTSTRAP_FILE_BUDGET_CHARS）
    if (remainingTotalChars < MIN_FILE_BUDGET_CHARS) {
      warn(`remaining budget is ${remainingTotalChars} chars (<${MIN_FILE_BUDGET_CHARS}); skipping remaining files`);
      break;
    }

    // 读取文件
    let rawContent: string;
    try {
      rawContent = await readFile(join(agentDir, name), 'utf-8');
    } catch {
      // 文件不存在或无法读取，跳过
      continue;
    }

    // 空文件跳过
    const trimmedContent = rawContent.trim();
    if (!trimmedContent) {
      continue;
    }

    // 单文件预算 = min(maxFileChars, 剩余总预算)
    const fileBudget = Math.max(1, Math.min(maxFileChars, remainingTotalChars));

    // 截断
    const result = truncateContent(trimmedContent, name, fileBudget);
    if (result.truncated) {
      warn(`${name} is ${result.originalLength} chars (limit ${fileBudget}); truncating`);
    }

    // 扣减总预算
    remainingTotalChars = Math.max(0, remainingTotalChars - result.content.length);

    results.push({ path: name, content: result.content });
  }

  return results;
}
