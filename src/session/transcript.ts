import { readFileSync } from 'fs';
import { appendFile } from 'fs/promises';
import { withFileLock } from './lock.js';
import type { TranscriptEntry, TranscriptState } from './types.js';

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
