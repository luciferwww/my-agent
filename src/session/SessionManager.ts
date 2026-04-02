import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { loadStore, updateStore } from './store.js';
import { loadTranscript, resolveLinearPath, appendToTranscript } from './transcript.js';
import type {
  SessionEntry,
  SessionStore,
  TranscriptState,
  TranscriptEntry,
  MessageRecord,
  SessionRecord,
  ContentBlock,
} from './types.js';

const SESSIONS_DIR = 'sessions';
const STORE_FILE = 'sessions.json';
const TRANSCRIPT_VERSION = 1;

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

  /** 每个 Session 的内存状态（byId Map + leafId） */
  private transcripts = new Map<string, TranscriptState>();

  constructor(workspaceDir: string) {
    this.sessionsDir = join(workspaceDir, '.agent', SESSIONS_DIR);
    this.storePath = join(this.sessionsDir, STORE_FILE);
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
      role: 'user' | 'assistant' | 'system';
      content: string | ContentBlock[];
    },
  ): Promise<string> {
    const state = this.ensureTranscriptLoaded(key);
    const filePath = this.resolveTranscriptPath(key);

    const record: MessageRecord = {
      type: 'message',
      id: randomUUID(),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      message,
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

  // ── 内部方法 ──────────────────────────────────────────

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
