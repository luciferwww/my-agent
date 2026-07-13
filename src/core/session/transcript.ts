import { readFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import { withFileLock } from './lock.js';
import type { CompactionRecord, TranscriptEntry, TranscriptState } from './types.js';

/**
 * 加载 JSONL 文件，构建 byId Map 和 leafId。
 *
 * leafId 策略：取文件中最后一条记录的 id。
 * 这对线性对话是正确的（最后一条就是当前末端）。
 * 对有分支的文件也是合理的默认值（最后追加的记录是最近的活跃点）。
 *
 * 文件不存在返回空状态。
 */
export function loadTranscript(filePath: string): TranscriptState {
  const byId = new Map<string, TranscriptEntry>();
  let leafId: string | null = null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { byId, leafId };
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as TranscriptEntry;
      if (entry && typeof entry === 'object' && entry.id) {
        byId.set(entry.id, entry);
        leafId = entry.id;
      }
    } catch {
      // 跳过格式错误的行
    }
  }

  return { byId, leafId };
}

/**
 * 从 leafId 沿 parentId 回溯到根，返回正序路径。
 * 只返回 type === 'message' 的记录。
 */
export function resolveLinearPath(
  state: TranscriptState,
  leafId: string | null,
): TranscriptEntry[] {
  const path: TranscriptEntry[] = [];
  let currentId = leafId;

  while (currentId !== null) {
    const entry = state.byId.get(currentId);
    if (!entry) break;

    if (entry.type === 'message') {
      path.unshift(entry);
    }

    currentId = entry.parentId;
  }

  return path;
}

/**
 * 追加一条记录到 JSONL 文件（带锁）。
 */
export async function appendToTranscript(
  filePath: string,
  entry: TranscriptEntry,
): Promise<void> {
  await withFileLock(filePath, async () => {
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  });
}

/**
 * 在 TranscriptState 中查找最近一次压缩记录。
 *
 * resolveLinearPath() 在遍历 parentId 链时会跳过 type !== 'message' 的记录，
 * 因此压缩记录不会出现在 getMessages() 的返回值中。
 * 此函数专门从 byId Map 中扫描所有 type === 'compaction' 的记录，
 * 并返回时间戳最新的一条（即最近一次压缩）。
 *
 * 用途：AgentRunner.loadHistory() 调用此函数，判断是否需要：
 *   1. 截断历史（只取 firstKeptEntryId 之后的消息）
 *   2. 在历史消息最前面注入摘要消息
 *
 * @returns 最近一次 CompactionRecord，若从未压缩则返回 null
 */
export function findLastCompaction(state: TranscriptState): CompactionRecord | null {
  let last: CompactionRecord | null = null;

  for (const entry of state.byId.values()) {
    if (entry.type !== 'compaction') continue;

    const record = entry as CompactionRecord;
    // 以 timestamp 字符串比较（ISO 8601 格式天然支持字典序比较）
    if (!last || record.timestamp > last.timestamp) {
      last = record;
    }
  }

  return last;
}
