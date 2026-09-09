# Core Session Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: Session, Transcript, JSONL, message tree, and persistence behavior
> Ownership key: session-and-transcript-persistence

---

## 1. 概述

`src/core/session/` 负责会话消息历史的**持久化**：把 LLM 对话记录（用户消息、助手回复、tool result、压缩记录）以 JSONL 格式写入磁盘，并在每次 `runAttempt` 开始时重新加载。

---

## 2. 目录结构

```
src/core/session/
├── types.ts          # SessionEntry / TranscriptEntry / ContentBlock / TranscriptState
├── SessionManager.ts # 主类
├── transcript.ts     # JSONL 读写（loadTranscript / resolveLinearPath / appendToTranscript）
├── store.ts          # sessions.json 元数据索引（loadStore / updateStore）
├── lock.ts           # 文件写锁（withFileLock）
└── index.ts
```

---

## 3. 存储结构

```
<workspaceDir>/.agent/sessions/
├── sessions.json          # Session Store（元数据索引）
├── {sessionId}.jsonl      # Session Transcript（消息历史，每行一条记录）
└── ...
```

**sessions.json** 保存所有 Session 的元数据（`Record<sessionKey, SessionEntry>`），用于快速查找 session 而无需扫描 JSONL 文件。

**{sessionId}.jsonl** 每行一个 JSON 对象，类型为 `TranscriptEntry`（共 3 种）：

| 类型 | 说明 |
|---|---|
| `SessionRecord` | 首行，文件元信息（version、cwd） |
| `MessageRecord` | 消息记录（user / assistant / toolResult） |
| `CompactionRecord` | 压缩摘要记录（summary + firstKeptEntryId） |

---

## 4. 类型定义

### 4.1 SessionEntry（元数据）

```
SessionEntry {
  sessionId: string       // UUID
  sessionKey: string      // 调用方使用的 key（如 'main'）
  sessionFile: string     // '{sessionId}.jsonl'
  createdAt: number
  updatedAt: number
  status?: 'running' | 'done' | 'failed'
  totalTokens?: number
  compactionCount?: number
  spawnedBy?: string      // Subagent Child 的父 session key
}
```

### 4.2 TranscriptEntry（JSONL 记录）

```
TranscriptEntryBase {
  type: string
  id: string              // UUID，记录唯一标识
  parentId: string | null // 父记录 id，构成消息树
  timestamp: string       // ISO 8601
}

MessageRecord {
  type: 'message'
  message: {
    role: 'user' | 'assistant' | 'toolResult'
    content: string | ContentBlock[]
  }
}

CompactionRecord {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string   // 保留区起点，loadHistory 截断锚点
  tokensBefore: number
  tokensAfter: number
  trigger: 'preemptive' | 'overflow' | 'manual'
  droppedMessages: number
}
```

`toolResult` 是会话内部的 role（区别于 Anthropic API 的 `user` role）；`loadHistory` 在加载时把它转换为 `user` role 以对齐 API 格式。

---

## 5. SessionManager API

```
constructor(workspaceDir, options?)
  options.toolResultHeadChars  // 写入前对 tool result 做硬上限裁剪（头部保留字符数）
  options.toolResultTailChars  // 尾部保留字符数；两者同时设置才生效

createSession(key, opts?)         → SessionEntry     // 创建新 session，生成 UUID，写首行记录
getSession(key)                   → SessionEntry | null
resolveSession(key)               → SessionEntry     // 存在则返回，不存在则 createSession
deleteSession(key)                → void             // 删除元数据 + JSONL 文件

appendMessage(key, message)       → void             // 追加 MessageRecord（带 tool result 裁剪）
appendCompactionRecord(key, record, firstKeptEntryId) → void  // 追加 CompactionRecord
getMessages(key)                  → MessageRecord[]  // 返回 resolveLinearPath 的结果
getLastCompactionRecord(key)      → CompactionRecord | null
updateSession(key, partial)       → void             // 更新元数据（如 totalTokens）
```

---

## 6. 消息树结构

每条 TranscriptEntry 通过 `parentId` 链接，形成有向树。

```
session(root)
  ├─ message(user #1)
  │   └─ message(assistant #1)
  │       └─ message(toolResult #1)
  │           └─ message(assistant #2)
  │               └─ compaction         ← firstKeptEntryId = message(toolResult #1).id
  │                   └─ message(user #2)
  ...
```

`resolveLinearPath(state, leafId)` 从 leafId 沿 parentId 向根回溯，只保留 `type === 'message'` 的记录并反转顺序，得到线性消息序列。

`leafId` 策略：JSONL 文件最后一条记录的 id——对线性对话始终正确，对分支也是合理的默认值（最后追加的就是最近活跃点）。

---

## 7. 关键设计决策

| 决策 | 说明 |
|---|---|
| tool result 写入时截断 | `toolResultHeadChars + toolResultTailChars` 在 append 时做**一次性**截断，磁盘存储就是截断后的数据，loadHistory 无需重复处理 |
| JSONL append-only | 只追加，不重写——保证崩溃安全；compaction 也是追加一条记录，不删历史行 |
| 文件写锁 | `withFileLock` 防止并发 append 产生乱序（同 session 串行由 runtime 保证，锁作为防御兜底） |
| sessionKey 与 sessionId 分离 | `sessionKey` 是调用方的逻辑标识；`sessionId` 是内部 UUID，用于文件名和记录关联 |

Runtime owns queueing and Parent/Child execution lifecycle; Session owns the persisted `spawnedBy` relationship and isolated Child transcript. Runner owns when messages and Compaction records are appended. Provider-facing projection of internal `toolResult` records does not change their persisted role.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [SessionManager.ts](../../../src/core/session/SessionManager.ts), [types.ts](../../../src/core/session/types.ts), [transcript.ts](../../../src/core/session/transcript.ts), [store.ts](../../../src/core/session/store.ts), [lock.ts](../../../src/core/session/lock.ts) |
| Tests | [SessionManager.test.ts](../../../src/core/session/SessionManager.test.ts), [transcript.test.ts](../../../src/core/session/transcript.test.ts), [store.test.ts](../../../src/core/session/store.test.ts), [lock.test.ts](../../../src/core/session/lock.test.ts), [AgentRunner.test.ts](../../../src/core/runner/AgentRunner.test.ts) |
| Controlling authority | [Core Runner Turn Flow Spec](../core-runner-turn-flow-spec.md), [ADR-002](../adr-002-context-budgeting-and-compaction-recovery.md), [Core Abort Spec](../core-abort-spec.md) |
