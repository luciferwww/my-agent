// ── Config Wizard 显示层 ──────────────────────────────────
//
// 纯打印函数：
//   - printHelp           --help / -h 输出
//   - printDryRunSummary  save? 前的字段变更摘要 / 被丢弃字段 / 完整 JSON 预览
//
// Current contract: docs/architecture/current/platform_config.md#config-wizard

import type { ConfigFile } from '../types.js';

// ── ANSI helpers（仅 stderr 装饰，stdout 输出 raw） ──

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// ── printHelp ────────────────────────────────────────────

export function printHelp(): void {
  const lines = [
    'Usage: npx tsx scripts/config.ts [options]',
    '',
    'Interactive editor for config.json. Reads the file at <path> as the current',
    'state, walks the user through core and (optionally) advanced fields, then',
    'writes back only the values that differ from hard-coded defaults.',
    '',
    'Options:',
    '  --path <file>   Output file path. Also read as existing content on start.',
    '                  Default: <cwd>/config.json',
    '  -h, --help      Print this help and exit.',
    '',
    'Notes:',
    '  The default path <cwd>/config.json is NOT auto-loaded by the agent.',
    '  loadConfig() reads <workspaceDir>/.agent/config.json. Move the generated',
    '  file there, or pass --path <workspaceDir>/.agent/config.json directly.',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

// ── printDryRunSummary ───────────────────────────────────

export interface DryRunSummary {
  /** 输出文件路径，用于"will be written to <path>"提示 */
  path: string;
  /** 既有文件是否存在（决定是否提示 .bak） */
  hadExisting: boolean;
  /** 被 pickSchemaKeys 丢弃的字段 path 列表 */
  discarded: string[];
  /** 最终要写入的 ConfigFile */
  next: ConfigFile;
}

/**
 * 打印 dry-run 摘要。三段：
 *   §9.1 字段变更摘要（v1 暂未实现 + ~ - 详细 diff，先打印 "see preview below"）
 *   §9.2 被丢弃的 schema 外字段（仅在有时打印）
 *   §9.3 完整输出预览
 *
 * v1 的字段变更摘要被简化为"看下方完整预览自行确认"，避免实现一套 diff
 * 展示算法。完整预览已经包含全部要写入的内容，对用户决策足够。
 */
export function printDryRunSummary(summary: DryRunSummary): void {
  const { path, hadExisting, discarded, next } = summary;

  process.stdout.write('\n' + bold('━━ Dry-run summary ━━') + '\n\n');

  // 9.2 被丢弃字段（如有）
  if (discarded.length > 0) {
    process.stdout.write(
      yellow('Discarded fields (not in current schema, will be removed):') + '\n',
    );
    for (const p of discarded) {
      process.stdout.write(`  - ${p}\n`);
    }
    if (hadExisting) {
      process.stdout.write(
        '\n' + dim(`A backup of the previous file will be saved to ${path}.bak before writing.`) + '\n',
      );
    }
    process.stdout.write('\n');
  } else if (hadExisting) {
    process.stdout.write(
      dim(`Existing file will be backed up to ${path}.bak before writing.`) + '\n\n',
    );
  }

  // 9.3 完整输出预览
  process.stdout.write(`Final config.json content (will be written to ${path}):\n`);
  process.stdout.write(JSON.stringify(next, null, 2) + '\n\n');
}

// ── 信息提示 ──────────────────────────────────────────────

export function printSectionHeader(name: string): void {
  process.stdout.write('\n' + dim('── ' + name + ' ──') + '\n');
}

export function printCancelled(): void {
  process.stdout.write(yellow('Cancelled, no changes written.\n'));
}

export function printSaved(path: string, backupCreated: boolean): void {
  process.stdout.write(bold(`Saved to ${path}\n`));
  if (backupCreated) {
    process.stdout.write(dim(`Backup at ${path}.bak\n`));
  }
}

export function printBackupFailed(path: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    yellow(`Warning: failed to back up to ${path}.bak: ${msg}\n`),
  );
  process.stderr.write(dim('Continuing with write — existing file content will be overwritten.\n'));
}

export function printExistingParseError(path: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    yellow(`Warning: failed to parse ${path}: ${msg}\n`),
  );
  process.stderr.write(dim('Treating existing as empty {} — original file untouched until save.\n'));
}
