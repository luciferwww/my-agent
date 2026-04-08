import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecallEntry } from './types.js';

const RECALL_LOG_FILE = 'recall-log.jsonl';

/**
 * 召回追踪器。
 *
 * 每次 memory_search 后异步记录查询和命中结果。
 * fire-and-forget，不阻塞搜索返回。
 * V1 只写不读——为将来的自动记忆整理积累数据。
 */
export class RecallTracker {
  private recallDir: string;
  private logPath: string;
  private dirEnsured = false;

  constructor(recallDir: string) {
    this.recallDir = recallDir;
    this.logPath = join(recallDir, RECALL_LOG_FILE);
  }

  /**
   * 异步记录召回，fire-and-forget。
   * 写入失败时静默忽略，不影响主流程。
   */
  record(entry: RecallEntry): void {
    this.writeEntry(entry).catch(() => {
      // 静默忽略写入错误
    });
  }

  // ── 内部方法 ──────────────────────────────────────────

  private async writeEntry(entry: RecallEntry): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(entry) + '\n';
    await appendFile(this.logPath, line, 'utf-8');
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.recallDir, { recursive: true });
    this.dirEnsured = true;
  }
}
