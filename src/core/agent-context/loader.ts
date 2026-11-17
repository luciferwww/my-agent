import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ContextFile } from './types.js';
import { DEFAULT_AGENT_CONTEXT_CONFIG } from './config.js';

/** Supported Context files in their fixed loading order. */
const ALL_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'TOOLS.md',
] as const;

const MINIMAL_FILES = [
  'IDENTITY.md',
  'SOUL.md',
] as const;

/**
 * Truncation policy constants, following OpenClaw's bootstrap.ts:
 *   BOOTSTRAP_HEAD_RATIO = 0.7
 *   BOOTSTRAP_TAIL_RATIO = 0.2
 *   MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64
 */
const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;
const MIN_FILE_BUDGET_CHARS = 64;

/** Default per-file character limit matches OpenClaw's DEFAULT_BOOTSTRAP_MAX_CHARS. */
/**
 * Truncate content to a 70% head and 20% tail with a marker between them.
 * Follows OpenClaw's trimBootstrapContent().
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
  /** Loading mode; defaults to full. Minimal loads only IDENTITY.md and SOUL.md. */
  mode?: 'full' | 'minimal';
  /** Per-file character limit; defaults to 20,000, matching OpenClaw. */
  maxFileChars?: number;
  /** Total character budget; defaults to 150,000, matching OpenClaw. */
  maxTotalChars?: number;
  /** Warning callback for truncated or budget-skipped files; defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Read the supported file sequence from baseDir and apply loading budgets.
 *
 * The caller supplies the complete base directory; this helper does not alter it.
 */
async function loadFilesFromBaseDir(
  baseDir: string,
  fileList: readonly string[],
  opts: {
    maxFileChars: number;
    maxTotalChars: number;
    warn: (msg: string) => void;
  },
): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  for (const name of fileList) {
    try {
      files.push({ path: name, content: await readFile(join(baseDir, name), 'utf-8') });
    } catch {
      // Skip missing or unreadable files.
      continue;
    }
  }
  return prepareContextFiles(files, opts);
}

export function prepareContextFiles(
  files: readonly Readonly<ContextFile>[],
  options?: LoadContextFilesOptions,
): ContextFile[] {
  const opts = {
    maxFileChars: options?.maxFileChars ?? DEFAULT_AGENT_CONTEXT_CONFIG.maxFileChars,
    maxTotalChars: options?.maxTotalChars ?? DEFAULT_AGENT_CONTEXT_CONFIG.maxTotalChars,
    warn: options?.warn ?? console.warn,
  };
  const { maxFileChars, warn } = opts;
  const maxTotalChars = Math.max(1, opts.maxTotalChars);
  const results: ContextFile[] = [];
  let remainingTotalChars = maxTotalChars;

  for (const { path: name, content: rawContent } of files) {
    // The total budget is exhausted.
    if (remainingTotalChars <= 0) {
      break;
    }

    // Skip remaining files below OpenClaw's minimum file budget.
    if (remainingTotalChars < MIN_FILE_BUDGET_CHARS) {
      warn(`remaining budget is ${remainingTotalChars} chars (<${MIN_FILE_BUDGET_CHARS}); skipping remaining files`);
      break;
    }

    // Skip empty files.
    const trimmedContent = rawContent.trim();
    if (!trimmedContent) {
      continue;
    }

    // Limit this file to the smaller of the per-file and remaining budgets.
    const fileBudget = Math.max(1, Math.min(maxFileChars, remainingTotalChars));

    // Truncate when necessary.
    const result = truncateContent(trimmedContent, name, fileBudget);
    if (result.truncated) {
      warn(`${name} is ${result.originalLength} chars (limit ${fileBudget}); truncating`);
    }

    // Deduct the loaded content from the total budget.
    remainingTotalChars = Math.max(0, remainingTotalChars - result.content.length);

    results.push({ path: name, content: result.content });
  }

  return results;
}

/**
 * Load Context files from the Agent Home root.
 *
 * Loading rules:
 * - Fixed order: IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md.
 * - Skip missing and whitespace-only files.
 * - Warn and truncate oversized files to a 70% head, 20% tail and marker.
 * - Warn and truncate or skip files when the total budget is exhausted.
 * - Warn and skip remaining files when fewer than 64 characters remain.
 *
 * Follows OpenClaw's buildBootstrapContextFiles() in
 * src/agents/pi-embedded-helpers/bootstrap.ts.
 *
 * @param agentHome - Agent Context root directory.
 * @param opts - Optional loading configuration.
 */
export async function loadContextFiles(
  agentHome: string,
  opts?: LoadContextFilesOptions,
): Promise<ContextFile[]> {
  return loadFilesFromBaseDir(
    agentHome,
    opts?.mode === 'minimal' ? MINIMAL_FILES : ALL_FILES,
    {
      maxFileChars: opts?.maxFileChars ?? DEFAULT_AGENT_CONTEXT_CONFIG.maxFileChars,
      maxTotalChars: opts?.maxTotalChars ?? DEFAULT_AGENT_CONTEXT_CONFIG.maxTotalChars,
      warn: opts?.warn ?? console.warn,
    },
  );
}

/**
 * Load supported Context files from an absolute directory, using the same
 * ALL_FILES / MINIMAL_FILES lists as {@link loadContextFiles}.
 * Files outside those lists are never read.
 *
 * Unlike loadContextFiles(agentHome, opts), read directly from the complete
 * directory path supplied by the caller.
 *
 * Truncation, budgets and mode match loadContextFiles.
 *
 * @param absDir - Absolute directory to read.
 * @param opts - Optional loading configuration.
 */
export async function loadContextFilesFromDir(
  absDir: string,
  opts?: LoadContextFilesOptions,
): Promise<ContextFile[]> {
  return loadFilesFromBaseDir(
    absDir,
    opts?.mode === 'minimal' ? MINIMAL_FILES : ALL_FILES,
    {
      maxFileChars: opts?.maxFileChars ?? DEFAULT_AGENT_CONTEXT_CONFIG.maxFileChars,
      maxTotalChars: opts?.maxTotalChars ?? DEFAULT_AGENT_CONTEXT_CONFIG.maxTotalChars,
      warn: opts?.warn ?? console.warn,
    },
  );
}