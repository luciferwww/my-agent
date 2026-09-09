// ── Config Wizard 主编排 ──────────────────────────────────
//
// 流程：parse argv → load existing → ask core → ask advanced (optional)
//   → buildNextConfig → dry-run summary → save? → backup .bak → write
//
// Current contract: docs/architecture/current/platform_config.md#config-wizard

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { buildNextConfig } from './diff.js';
import { askAdvancedFields, askCoreFields } from './fields.js';
import {
  printBackupFailed,
  printCancelled,
  printDryRunSummary,
  printExistingParseError,
  printHelp,
  printSaved,
} from './display.js';
import { askYesNo, createReadlineSession, type ReadlineSession } from './prompts.js';
import type { ConfigFile } from '../types.js';

// ── WizardArgError ────────────────────────────────────────

/**
 * argv 解析错误。带 exitCode 字段，薄壳 catch 时按此字段决定 process.exit code。
 * runWizard 绝不调 process.exit — 这是其可被 IDE / WebUI 内嵌复用的硬约束。
 */
export class WizardArgError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'WizardArgError';
    this.exitCode = exitCode;
  }
}

// ── argv 解析 ─────────────────────────────────────────────

interface ParsedArgs {
  /** 若为 true，runWizard 应仅打印 help 后 return */
  help: boolean;
  /** 输出路径（绝对路径） */
  path: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    help: false,
    path: resolve(process.cwd(), 'config.json'),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      args.help = true;
      // 帮助优先，后续参数解析不再 matter；但仍走完循环以验证形式合法
      continue;
    }
    if (a === '--path') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new WizardArgError('--path requires a file path argument');
      }
      args.path = resolve(process.cwd(), next);
      i++;
      continue;
    }
    if (a.startsWith('--path=')) {
      const v = a.slice('--path='.length);
      if (v === '') {
        throw new WizardArgError('--path= requires a non-empty value');
      }
      args.path = resolve(process.cwd(), v);
      continue;
    }
    throw new WizardArgError(`Unknown argument: ${a}`);
  }

  return args;
}

// ── 既有 config 加载 ──────────────────────────────────────

function loadExisting(path: string): { existing: ConfigFile; existed: boolean } {
  if (!existsSync(path)) {
    return { existing: {}, existed: false };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      printExistingParseError(path, new Error('top-level is not an object'));
      return { existing: {}, existed: true };
    }
    return { existing: parsed as ConfigFile, existed: true };
  } catch (err) {
    printExistingParseError(path, err);
    return { existing: {}, existed: true };
  }
}

// ── runWizard ─────────────────────────────────────────────

/**
 * Config Wizard 入口。
 *
 * 行为：
 * - argv 错误 → throw WizardArgError (exitCode=2)
 * - 写入失败 / 其它运行时错误 → throw Error
 * - 正常 save / cancel / --help → 正常 return
 *
 * 不调用 process.exit。由调用方（薄壳或 IDE host）根据返回 / 抛出决定行为。
 */
export async function runWizard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  const { existing, existed } = loadExisting(args.path);

  const session: ReadlineSession = createReadlineSession();

  try {
    const core = await askCoreFields(session, {
      agentsDefaults: existing.agents?.defaults ?? {},
      logger: existing.logger ?? {},
    });

    const advanced = await askAdvancedFields(
      session,
      {
        agentsDefaults: existing.agents?.defaults ?? {},
        logger: existing.logger ?? {},
      },
      core,
    );

    const { next, discarded } = buildNextConfig({
      existing,
      collected: {
        agentsDefaults: advanced.agentsDefaults,
        logger: advanced.logger,
      },
    });

    printDryRunSummary({
      path: args.path,
      hadExisting: existed,
      discarded,
      next,
    });

    const shouldSave = await askYesNo(session, 'Save to file?', true);
    if (!shouldSave) {
      printCancelled();
      return;
    }

    // backup + write
    let backupCreated = false;
    if (existed) {
      try {
        copyFileSync(args.path, args.path + '.bak');
        backupCreated = true;
      } catch (err) {
        printBackupFailed(args.path, err);
        // 不阻塞主流程
      }
    }

    const json = JSON.stringify(next, null, 2) + '\n';
    writeFileSync(args.path, json, 'utf-8');

    printSaved(args.path, backupCreated);
  } finally {
    session.close();
  }
}
