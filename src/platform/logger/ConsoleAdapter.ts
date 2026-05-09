import type { LogAdapter, LogEntry, LogLevel } from './types.js';

export interface ConsoleAdapterConfig {
  /** 此 adapter 的最低输出级别；不设则跟随 Logger 全局 minLevel */
  minLevel?: LogLevel;
  /** 是否输出彩色；默认 TTY 环境开启 */
  colors?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[37m',  // white
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';

export class ConsoleAdapter implements LogAdapter {
  private readonly minLevel: LogLevel | undefined;
  private readonly colors: boolean;

  constructor(config?: ConsoleAdapterConfig) {
    this.minLevel = config?.minLevel;
    this.colors = config?.colors ?? (process.stdout.isTTY === true);
  }

  write(entry: LogEntry): void {
    if (this.minLevel !== undefined && LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const ts = entry.timestamp.toISOString();
    const label = LEVEL_LABEL[entry.level];
    const ctx = entry.context !== undefined ? ' ' + JSON.stringify(entry.context) : '';
    const line = `[${ts}] [${label}] [${entry.module}] ${entry.message}${ctx}`;

    if (this.colors) {
      const colored = `${COLOR[entry.level]}${line}${RESET}`;
      if (entry.level === 'error') {
        process.stderr.write(colored + '\n');
      } else {
        process.stdout.write(colored + '\n');
      }
    } else {
      if (entry.level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    }
  }
}
