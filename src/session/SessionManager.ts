import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { loadStore, updateStore } from './store.js';
import { loadTranscript, resolveLinearPath, appendToTranscript, findLastCompaction } from './transcript.js';
import type {
  SessionEntry,
  TranscriptState,
  MessageRecord,
  SessionRecord,
  CompactionRecord,
  ContentBlock,
} from './types.js';

const SESSIONS_DIR = 'sessions';
const STORE_FILE = 'sessions.json';
const TRANSCRIPT_VERSION = 1;

/**
 * SessionManager 构造选项。
 *
 * toolResultHeadChars / toolResultTailChars：
 *   写入 JSONL 前对 tool result 内容做硬上限裁剪。
 *   裁剪后磁盘上存储的就是截断数据，后续每次 loadHistory() 加载时无需重复裁剪。
 *   两个字段同时设置才生效；未设置则不裁剪（向后兼容）。
 */
export interface SessionManagerOptions {
  /** 保留 tool result 头部的最大字符数 */
  toolResultHeadChars?: number;
  /** 保留 tool result 尾部的最大字符数 */
  toolResultTailChars?: number;
}

/**
 * Session 管理器。
 *
 * 管理 Session 的创建/查询/更新/删除，以及树形消息历史的追加/读取/分支。
 *
 * 存储结构：
 *   <workspaceDir>/.agent/sessions/sessions.json   — Session Store（元数据索引）
 *   <workspaceDir>/.agent/sessions/{sessionId}.jsonl — Session Transcript（树形消息历史）
 *
 * 参考 OpenClaw 的 Session 管理系统 + pi-coding-agent 的树形 SessionManager。
 */
export class SessionManager {
  private readonly sessionsDir: string;
  private readonly storePath: string;
  private readonly options: SessionManagerOptions;

  /** 每个 Session 的内存状态（byId Map + leafId） */
  private transcripts = new Map<string, TranscriptState>();

  constructor(workspaceDir: string, options: SessionManagerOptions = {}) {
    this.sessionsDir = join(workspaceDir, '.agent', SESSIONS_DIR);
    this.storePath = join(this.sessionsDir, STORE_FILE);
    this.options = options;
  }

  // ── Session CRUD ─────────────────────────────────────

  /**
   * 创建新 Session。
   * 生成 UUID，创建 JSONL 文件（含 session 首行记录），写入 Store。
   */
  async createSession(
    key: string,
    opts?: { spawnedBy?: string },
  ): Promise<SessionEntry> {
    await mkdir(this.sessionsDir, { recursive: true });

    const sessionId = randomUUID();
    const sessionFile = `${sessionId}.jsonl`;
    const now = Date.now();

    const entry: SessionEntry = {
      sessionId,
      sessionKey: key,
      sessionFile,
      createdAt: now,
      updatedAt: now,
      ...(opts?.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
    };

    // 创建 JSONL 文件，写入 session 首行记录
    const sessionRecord: SessionRecord = {
      type: 'session',
      id: randomUUID(),
      parentId: null,
      timestamp: new Date(now).toISOString(),
      version: TRANSCRIPT_VERSION,
    };

    const filePath = join(this.sessionsDir, sessionFile);
    await writeFile(filePath, JSON.stringify(sessionRecord) + '\n', 'utf-8');

    // 初始化内存状态
    const state: TranscriptState = {
      byId: new Map([[sessionRecord.id, sessionRecord]]),
      leafId: sessionRecord.id,
    };
    this.transcripts.set(key, state);

    // 写入 Store
    await updateStore(this.storePath, (store) => {
      if (store[key]) {
        throw new Error(`Session key "${key}" already exists`);
      }
      store[key] = entry;
    });

    return entry;
  }

  /**
   * 获取已有 Session 或创建新的。
   */
  async resolveSession(
    key: string,
    opts?: { spawnedBy?: string },
  ): Promise<{ entry: SessionEntry; isNew: boolean }> {
    const existing = this.getSession(key);
    if (existing) {
      return { entry: existing, isNew: false };
    }
    const entry = await this.createSession(key, opts);
    return { entry, isNew: true };
  }

  /** 通过 key 获取 SessionEntry，不存在返回 undefined */
  getSession(key: string): SessionEntry | undefined {
    const store = loadStore(this.storePath);
    return store[key];
  }

  /** 列出所有 Session */
  listSessions(): SessionEntry[] {
    const store = loadStore(this.storePath);
    return Object.values(store);
  }

  /** 更新 SessionEntry 元数据 */
  async updateSession(
    key: string,
    fields: Partial<SessionEntry>,
  ): Promise<void> {
    await updateStore(this.storePath, (store) => {
      const entry = store[key];
      if (!entry) {
        throw new Error(`Session key "${key}" not found`);
      }
      Object.assign(entry, fields, { updatedAt: Date.now() });
    });
  }

  /** 删除 Session（Store 条目 + JSONL 文件） */
  async deleteSession(key: string): Promise<void> {
    const entry = this.getSession(key);
    if (!entry) return;

    // 删除 JSONL 文件
    try {
      await unlink(join(this.sessionsDir, entry.sessionFile));
    } catch {
      // 文件不存在，忽略
    }

    // 删除 Store 条目
    await updateStore(this.storePath, (store) => {
      delete store[key];
    });

    // 清理内存状态
    this.transcripts.delete(key);
  }

  // ── 消息操作（树形） ──────────────────────────────────

  /**
   * 追加消息到当前分支末端。
   * parentId 自动设为当前 leafId。
   * 返回新消息的 id。
   */
  async appendMessage(
    key: string,
    message: {
      role: 'user' | 'assistant' | 'toolResult';
      content: string | ContentBlock[];
    },
  ): Promise<string> {
    const state = this.ensureTranscriptLoaded(key);
    const filePath = this.resolveTranscriptPath(key);

    // 写盘前对 toolResult 做硬上限裁剪。
    // 裁剪后 JSONL 存储的是截断数据，后续 loadHistory() 无需重复裁剪。
    const persistedMessage = message.role === 'toolResult'
      ? { ...message, content: this.capToolResults(message.content as ContentBlock[]) }
      : message;

    const record: MessageRecord = {
      type: 'message',
      id: randomUUID(),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      message: persistedMessage,
    };

    // 写入 JSONL
    await appendToTranscript(filePath, record);

    // 更新内存
    state.byId.set(record.id, record);
    state.leafId = record.id;

    // 更新 Store 的 updatedAt
    await updateStore(this.storePath, (store) => {
      const entry = store[key];
      if (entry) {
        entry.updatedAt = Date.now();
      }
    });

    return record.id;
  }

  /**
   * 获取当前分支的线性消息列表。
   * 从 leafId 沿 parentId 回溯到根，返回正序排列的 MessageRecord。
   */
  getMessages(key: string): MessageRecord[] {
    const state = this.ensureTranscriptLoaded(key);
    return resolveLinearPath(state, state.leafId) as MessageRecord[];
  }

  /**
   * 将 leafId 移动到指定记录。
   * 后续 appendMessage 从该点展开新分支。
   * 不修改 JSONL 文件，只修改内存中的 leafId 指针。
   */
  branch(key: string, entryId: string): void {
    const state = this.ensureTranscriptLoaded(key);
    if (!state.byId.has(entryId)) {
      throw new Error(`Entry "${entryId}" not found in session "${key}"`);
    }
    state.leafId = entryId;
  }

  /** 获取当前 leafId */
  getLeafId(key: string): string | null {
    const state = this.ensureTranscriptLoaded(key);
    return state.leafId;
  }

  // ── 压缩记录操作 ──────────────────────────────────────

  /**
   * 将压缩记录追加到 JSONL，并更新内存中的 byId。
   *
   * 与 appendMessage() 的关键区别：
   *   - parentId 自动设为当前 leafId（记录在压缩发生时的链表末端位置）
   *   - **不更新 leafId**：压缩记录是一个"标记节点"，不是消息链表的一部分，
   *     后续消息仍然从原 leafId 继续追加，不从压缩记录分叉
   *   - 写入后通过 findLastCompaction() 可查询到此记录
   *
   * @param key       Session key
   * @param record    compactMessages() 返回的 record（parentId 和 firstKeptEntryId 由此方法填入）
   * @param firstKeptEntryId  保留区第一条消息的 ID，用于 loadHistory() 截断历史
   */
  async appendCompactionRecord(
    key: string,
    record: Omit<CompactionRecord, 'parentId' | 'firstKeptEntryId'>,
    firstKeptEntryId: string,
  ): Promise<void> {
    const state = this.ensureTranscriptLoaded(key);
    const filePath = this.resolveTranscriptPath(key);

    const fullRecord: CompactionRecord = {
      ...record,
      parentId: state.leafId,   // 记录在当前链表末端
      firstKeptEntryId,
    };

    // 写入 JSONL
    await appendToTranscript(filePath, fullRecord);

    // 更新内存 byId（不动 leafId）
    state.byId.set(fullRecord.id, fullRecord);

    // 更新 Store 元数据：递增压缩次数、更新时间戳
    await updateStore(this.storePath, (store) => {
      const entry = store[key];
      if (entry) {
        entry.compactionCount = (entry.compactionCount ?? 0) + 1;
        entry.updatedAt = Date.now();
      }
    });
  }

  /**
   * 获取最近一次压缩的摘要文本。
   *
   * 供 loadHistory() 判断是否需要在历史消息前注入摘要。
   * 若 session 从未压缩过，返回 null。
   *
   * @returns 摘要字符串，或 null（未压缩）
   */
  getLastCompactionSummary(key: string): string | null {
    const state = this.ensureTranscriptLoaded(key);
    const record = findLastCompaction(state);
    return record?.summary ?? null;
  }

  /**
   * 获取最近一次压缩记录的完整信息。
   *
   * 供 loadHistory() 读取 firstKeptEntryId，用于截断历史消息列表。
   * 若 session 从未压缩过，返回 null。
   */
  getLastCompactionRecord(key: string): CompactionRecord | null {
    const state = this.ensureTranscriptLoaded(key);
    return findLastCompaction(state);
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 对 toolResult 消息的每个 block 做硬上限裁剪（写盘专用）。
   *
   * 仅当 options.toolResultHeadChars 和 toolResultTailChars 均已设置时生效。
   * 裁剪格式与 Layer 1 pruneToolResults 一致（head + "..." + tail + 标记行），
   * 保证裁剪后内容对 LLM 可读，且不会在未来加载时被再次误裁剪。
   */
  private capToolResults(blocks: ContentBlock[]): ContentBlock[] {
    const { toolResultHeadChars, toolResultTailChars } = this.options;
    if (!toolResultHeadChars || !toolResultTailChars) {
      return blocks; // 未配置则不裁剪
    }

    const maxChars = toolResultHeadChars + toolResultTailChars;
    return blocks.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= maxChars) {
        return block;
      }
      const head = block.content.slice(0, toolResultHeadChars);
      const tail = block.content.slice(-toolResultTailChars);
      const capped = `${head}\n\n...\n\n${tail}`
        + `\n\n[Tool result trimmed: kept first ${toolResultHeadChars} and last ${toolResultTailChars}`
        + ` of ${block.content.length} chars]`;
      return { ...block, content: capped };
    });
  }

  /**
   * 确保 Transcript 已加载到内存。
   * 首次访问时从 JSONL 文件加载，后续使用内存缓存。
   */
  private ensureTranscriptLoaded(key: string): TranscriptState {
    let state = this.transcripts.get(key);
    if (state) return state;

    const entry = this.getSession(key);
    if (!entry) {
      throw new Error(`Session key "${key}" not found`);
    }

    const filePath = join(this.sessionsDir, entry.sessionFile);
    state = loadTranscript(filePath);
    this.transcripts.set(key, state);
    return state;
  }

  /** 解析 JSONL 文件的完整路径 */
  private resolveTranscriptPath(key: string): string {
    const entry = this.getSession(key);
    if (!entry) {
      throw new Error(`Session key "${key}" not found`);
    }
    return join(this.sessionsDir, entry.sessionFile);
  }
}
