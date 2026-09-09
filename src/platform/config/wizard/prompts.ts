// ── Config Wizard 交互原语 ────────────────────────────────
//
// 提供 Prompt<T> 类型、ask() 函数（含回车保留 / 重试循环）、
// 通用 parser（string / number / boolean / enum / optional 字段清空）。
//
// Current contract: docs/architecture/current/platform_config.md#config-wizard

import { createInterface, type Interface } from 'node:readline';

// ── Prompt 类型 ────────────────────────────────────────────

/** 单个字段的交互定义 */
export interface Prompt<T> {
  /** 字段路径，如 'llm.maxTokens'；用于 diff / 日志 */
  path: string;
  /** 用户可见的字段标签 */
  label: string;
  /** 当前值（来自既有文件，或硬编码默认） */
  current: T | undefined;
  /** 硬编码默认值（用于 diff 阶段判断是否需写出） */
  default: T;
  /** 字符串 → T 的解析器（失败抛 Error，由 ask() 捕获后让用户重输） */
  parse: (input: string) => T;
  /** T → 显示字符串（v1 仅用于格式化非字符串类型，如 boolean → 'y/n'） */
  display?: (value: T | undefined) => string;
  /** 额外校验（可选） */
  validate?: (value: T) => void;
}

// ── Readline session ──────────────────────────────────────

/** 抽象 readline 接口，便于测试时注入 fake */
export interface ReadlineSession {
  question(prompt: string): Promise<string>;
  close(): void;
}

/** 基于 node:readline 的默认实现 */
export function createReadlineSession(): ReadlineSession {
  // TTY 模式下启用 terminal feature（行编辑 / 历史等）；
  // 非 TTY（管道输入、CI、自动化测试）必须关掉 terminal。
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });

  // pipe 输入时 readline 会一口气把所有 line 事件 emit 出来；如果用 rl.question
  // 的一次性 listener，wizard 还没问到第二个字段就已经错过若干行。
  // 这里自己维护 line buffer + pending resolvers，保证每个 line 都能被消费。
  const lineBuffer: string[] = [];
  const pendingResolvers: ((s: string) => void)[] = [];
  let closed = false;

  rl.on('line', (line) => {
    const resolver = pendingResolvers.shift();
    if (resolver) {
      resolver(line);
    } else {
      lineBuffer.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    // 所有 pending resolver 用 '' 解决（按"回车保留"语义继续）
    while (pendingResolvers.length > 0) {
      pendingResolvers.shift()!('');
    }
  });

  return {
    question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      return new Promise<string>((resolve) => {
        if (lineBuffer.length > 0) {
          resolve(lineBuffer.shift()!);
          return;
        }
        if (closed) {
          resolve('');
          return;
        }
        pendingResolvers.push(resolve);
      });
    },
    close(): void {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
  };
}

// ── ask() ────────────────────────────────────────────────

const SENTINEL_CLEAR = '--';

function defaultDisplay(value: unknown): string {
  if (value === undefined) return '<unset>';
  if (typeof value === 'boolean') return value ? 'y' : 'n';
  if (typeof value === 'string') return value === '' ? '<empty>' : value;
  return String(value);
}

/**
 * 询问单个字段。
 *
 * - 回车 → 返回 current（保留）
 * - `--` → 返回 undefined（清空 optional 字段）
 * - 任何输入 → 走 parse + validate；失败原地重输
 */
export async function ask<T>(
  session: ReadlineSession,
  p: Prompt<T>,
): Promise<T | undefined> {
  const shown = (p.display ?? defaultDisplay)(p.current);

  // optional 字段（current 或 default 为 undefined 的"可清空"语义）才提示 --
  const clearHint = p.current !== undefined ? ' (enter -- to clear)' : '';

  while (true) {
    const raw = await session.question(`${p.label} [current: ${shown}]${clearHint}: `);
    const input = raw.trim();

    if (input === '') return p.current;
    if (input === SENTINEL_CLEAR) return undefined;

    try {
      const v = p.parse(input);
      p.validate?.(v);
      return v;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ✗ ${msg}, please re-enter\n`);
    }
  }
}

/**
 * 询问 y/N 问题（如 "configure advanced? y/N"）。空输入视为 No。
 * 与 ask() 不同：不需要 Prompt<T> 抽象，直接返回 boolean。
 */
export async function askYesNo(
  session: ReadlineSession,
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
  while (true) {
    const raw = (await session.question(`${question}${suffix}: `)).trim().toLowerCase();
    if (raw === '') return defaultYes;
    if (['y', 'yes', 'true', '1'].includes(raw)) return true;
    if (['n', 'no', 'false', '0'].includes(raw)) return false;
    process.stderr.write(`  ✗ expected y/n\n`);
  }
}

// ── 通用 parser ──────────────────────────────────────────

export const parseString = (s: string): string => s;

export const parseNumber = (s: string): number => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error('not a number');
  return n;
};

export const parseInteger = (s: string): number => {
  const n = parseNumber(s);
  if (!Number.isInteger(n)) throw new Error('not an integer');
  return n;
};

export const parseBoolean = (s: string): boolean => {
  const l = s.toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(l)) return true;
  if (['n', 'no', 'false', '0'].includes(l)) return false;
  throw new Error('expected y/n');
};

export function parseEnum<T extends string>(allowed: readonly T[]): (s: string) => T {
  return (s: string): T => {
    if (!(allowed as readonly string[]).includes(s)) {
      throw new Error(`expected one of: ${allowed.join(', ')}`);
    }
    return s as T;
  };
}
