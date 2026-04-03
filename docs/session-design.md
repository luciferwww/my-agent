# Session 模块设计文档

> 创建日期：2026-04-02  
> 参考：OpenClaw 的 Session 管理系统（详见 [openclaw-session-analysis.md](./openclaw-session-analysis.md)）

---

## 1. 概述

Session 模块负责管理 Agent 的对话会话，是连接所有模块的核心——没有 Session，就没法管理多轮对话、没法给 LLM 传历史消息。

**职责**：
- Session 的创建、查询、更新、删除
- 消息历史的持久化（树形 JSONL，支持分支）
- 并发写入保护（文件锁）

**不属于 Session 模块的职责**：
- Session 队列（同一 Session 消息排队执行）— 属于执行引擎
- 对话压缩（compaction）— 属于执行引擎
- 历史裁剪（limitHistoryTurns）— 属于执行引擎
- 上下文窗口计算 — 属于执行引擎

> OpenClaw 中这些也是分开的——Session 存储在 `src/config/sessions/`，压缩/裁剪在 `src/agents/pi-embedded-runner/`。

---

## 2. 存储架构

与 OpenClaw 一致，采用两层存储：

```
<workspaceDir>/.agent/sessions/
├── sessions.json                    # Session Store（元数据索引）
├── {sessionId}.jsonl                # Session Transcript（消息历史，树形）
├── {sessionId}.jsonl
└── ...
```

**Session Store**（`sessions.json`）：所有 Session 的元数据索引，JSON 格式。快速列出/查询 Session，不需要读 JSONL。

**Session Transcript**（`{sessionId}.jsonl`）：单个 Session 的完整消息历史，树形 JSONL 格式。每条记录包含 `id` 和 `parentId`，支持分支。

### 2.1 与 OpenClaw 的对比

| | OpenClaw | 我们 |
|---|---|---|
| Store 路径 | `~/.openclaw/agents/{agentId}/sessions/sessions.json` | `<workspaceDir>/.agent/sessions/sessions.json` |
| Transcript 路径 | `~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl` | `<workspaceDir>/.agent/sessions/{sessionId}.jsonl` |
| Transcript 结构 | 树形（parentId） | 树形（parentId），与 OpenClaw 对齐 |
| Store 缓存 | ✅ 内存缓存 + stat 验证 | ❌ 暂不需要 |
| Store 锁 | ✅ `withSessionStoreLock()` | ✅ per-file Promise 队列 |
| Transcript 归档 | ✅ `archived/` 目录 | ❌ 暂不需要 |
| 维护清理 | ✅ 过期删除、条目限制、轮转 | ❌ 暂不需要 |

---

## 3. 数据结构

### 3.1 SessionEntry（元数据）

```typescript
interface SessionEntry {
  // 基础
  sessionId: string;          // UUID
  sessionKey: string;         // 调用方定义的标识符（如 "main"、"subagent:task-001"）
  sessionFile: string;        // JSONL 文件相对路径（如 "a1b2c3d4.jsonl"）
  createdAt: number;          // 创建时间戳（ms）
  updatedAt: number;          // 最后更新时间戳（ms）

  // 运行状态
  status?: 'running' | 'done' | 'failed';
  abortedLastRun?: boolean;   // 上次运行是否被中止

  // Token 统计
  totalTokens?: number;       // 总 token 数
  inputTokens?: number;       // 输入 token 数
  outputTokens?: number;      // 输出 token 数

  // 压缩
  compactionCount?: number;   // 压缩执行次数

  // 家族关系（sub agent）
  spawnedBy?: string;         // 父 Session Key
}
```

### 3.2 Transcript 记录类型

JSONL 文件中每行是一条记录，所有记录共享基础字段：

```typescript
/** 所有记录的基础字段（对齐 pi-coding-agent 的 SessionEntryBase） */
interface TranscriptEntryBase {
  type: string;               // 记录类型
  id: string;                 // 唯一 ID
  parentId: string | null;    // 父记录 ID（树形结构的关键）
  timestamp: string;          // ISO-8601 时间戳
}
```

#### 记录类型

**session 记录**（首行，文件元信息）：
```typescript
interface SessionRecord extends TranscriptEntryBase {
  type: 'session';
  version: number;            // 格式版本，用于未来迁移
  cwd?: string;               // 工作目录
}
```

**message 记录**（消息）：
```typescript
interface MessageRecord extends TranscriptEntryBase {
  type: 'message';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
  };
}
```

> **role 说明**：
> - `'user'`：用户消息
> - `'assistant'`：LLM 回复
> - `'toolResult'`：工具执行结果
>
> `'toolResult'` 是 pi-ai 库的设计决策（`ToolResultMessage.role = "toolResult"`），OpenClaw 直接继承。存储时用独立 role 区分清楚，发送给 Anthropic API 时由 agent-runner 转换为 `role: 'user'` + `{ type: 'tool_result', ... }` content block。
>
> system prompt 不存进历史（由 prompt-builder 每次实时生成）。

// ContentBlock 类型（对齐 Anthropic API）
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };
```

> **为什么不存 system prompt**：OpenClaw 也不把 system prompt 存进 JSONL。system prompt 由 prompt-builder 每次实时生成（因为时间、工具、contextFiles 每次可能不同），LLM API 只关心当前这次调用的 system prompt。OpenClaw 在 SessionEntry 中保存了一个 `systemPromptReport`（元数据报告：字符数、注入了哪些文件等），但不保存实际文本内容。

**compaction 记录**（压缩摘要，未来执行引擎使用）：
```typescript
interface CompactionRecord extends TranscriptEntryBase {
  type: 'compaction';
  summary: string;            // 压缩后的摘要文本
  firstKeptEntryId: string;   // 保留的第一条记录 ID
  tokensBefore: number;       // 压缩前的 token 数
}
```

### 3.3 树形结构说明

每条记录通过 `parentId` 指向父记录，形成树：

```
null ← (session record)
  └── msg-001 (user: "帮我重构这个函数")
      └── msg-002 (assistant: "好的，方案如下...")
          └── msg-003 (user: "用递归方式写")
              ├── msg-004 (assistant: "递归方案...")      ← 分支 A
              └── msg-005 (user: "用迭代方式写")          ← 分支 B
                  └── msg-006 (assistant: "迭代方案...")
```

内存中维护 `leafId` 指针，指向当前活跃分支的末端。新消息的 `parentId` 始终等于当前 `leafId`。

**分支操作**：`branch(nodeId)` 只移动 `leafId` 指针，不修改文件。后续追加的消息从该节点展开新分支。

**读取当前分支**：从 `leafId` 沿 `parentId` 回溯到根，得到线性消息列表。

### 3.4 JSONL 文件格式

```jsonl
{"type":"session","id":"sess-001","parentId":null,"timestamp":"2026-04-02T10:00:00Z","version":1}
{"type":"message","id":"msg-001","parentId":"sess-001","timestamp":"2026-04-02T10:00:01Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"msg-002","parentId":"msg-001","timestamp":"2026-04-02T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}
{"type":"message","id":"msg-003","parentId":"msg-002","timestamp":"2026-04-02T10:00:03Z","message":{"role":"user","content":"用递归方式写"}}
{"type":"message","id":"msg-004","parentId":"msg-003","timestamp":"2026-04-02T10:00:04Z","message":{"role":"assistant","content":[{"type":"text","text":"递归方案..."}]}}
{"type":"message","id":"msg-005","parentId":"msg-002","timestamp":"2026-04-02T10:00:05Z","message":{"role":"user","content":"用迭代方式写"}}
{"type":"message","id":"msg-006","parentId":"msg-005","timestamp":"2026-04-02T10:00:06Z","message":{"role":"assistant","content":[{"type":"text","text":"迭代方案..."}]}}
```

> msg-004 和 msg-005 的 parentId 不同（分别是 msg-003 和 msg-002），说明它们在不同分支上。

### 3.5 sessions.json 格式

```json
{
  "main": {
    "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "sessionKey": "main",
    "sessionFile": "a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl",
    "createdAt": 1711900000000,
    "updatedAt": 1711900005000,
    "totalTokens": 1500
  },
  "subagent:task-001": {
    "sessionId": "b2c3d4e5-f6a7-1234-5678-90abcdef0123",
    "sessionKey": "subagent:task-001",
    "sessionFile": "b2c3d4e5-f6a7-1234-5678-90abcdef0123.jsonl",
    "createdAt": 1711900010000,
    "updatedAt": 1711900015000,
    "spawnedBy": "main"
  }
}
```

---

## 4. Session Key

调用方自由定义的字符串标识符，不做格式约束：

| 场景 | Session Key 示例 |
|------|------------------|
| 主 Agent 对话 | `"main"` |
| Sub Agent 任务 | `"subagent:file-task-001"` |
| 特定主题 | `"topic:code-review"` |
| 定时任务 | `"cron:daily-check"` |

与 OpenClaw 的区别：
- OpenClaw 有严格的命名规则（`agent:{agentId}:{channel}:{scope}:{peerId}`），因为要处理多渠道多用户
- 我们不需要，调用方自己定义即可

---

## 5. 目录结构

```
src/
└── session/
    ├── index.ts              # 公共入口
    ├── types.ts              # SessionEntry, TranscriptEntry, ContentBlock 等类型
    ├── SessionManager.ts     # 主类
    ├── store.ts              # sessions.json 读写
    ├── transcript.ts         # 树形 JSONL 文件读写
    └── lock.ts               # 文件锁实现（per-file Promise 队列）
```

---

## 6. API 设计

```typescript
class SessionManager {
  constructor(workspaceDir: string);

  // ── Session CRUD ─────────────────────────────────────

  /** 创建新 Session，生成 UUID，创建 JSONL 文件（含 session 首行记录） */
  async createSession(key: string, opts?: { spawnedBy?: string }): Promise<SessionEntry>;

  /** 获取已有 Session 或创建新的，返回 { entry, isNew } */
  async resolveSession(key: string, opts?: { spawnedBy?: string }): Promise<{ entry: SessionEntry; isNew: boolean }>;

  /** 通过 key 获取 SessionEntry，不存在返回 undefined */
  getSession(key: string): SessionEntry | undefined;

  /** 列出所有 Session */
  listSessions(): SessionEntry[];

  /** 更新 SessionEntry 元数据 */
  async updateSession(key: string, fields: Partial<SessionEntry>): Promise<void>;

  /** 删除 Session（Store 条目 + JSONL 文件） */
  async deleteSession(key: string): Promise<void>;

  // ── 消息操作（树形） ──────────────────────────────────

  /** 追加消息到当前分支末端，parentId 自动设为当前 leafId */
  async appendMessage(key: string, message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
  }): Promise<string>;  // 返回新消息的 id

  /**
   * 获取当前分支的线性消息列表。
   * 从 leafId 沿 parentId 回溯到根，返回正序排列的消息。
   */
  getMessages(key: string): MessageRecord[];

  /**
   * 将 leafId 移动到指定记录，后续 appendMessage 从该点展开新分支。
   * 不修改 JSONL 文件，只修改内存中的 leafId 指针。
   */
  branch(key: string, entryId: string): void;

  /** 获取当前 leafId */
  getLeafId(key: string): string | null;
}
```

### 操作与锁

| 操作 | 读/写 | 锁 | 说明 |
|------|:-----:|:--:|------|
| `createSession` | 写 | ✅ Store 锁 | 写 sessions.json + 创建 JSONL |
| `getSession` | 读 | ❌ | 只读 sessions.json |
| `listSessions` | 读 | ❌ | 只读 sessions.json |
| `appendMessage` | 写 | ✅ JSONL 锁 | 追加到 JSONL + 更新内存 leafId |
| `getMessages` | 读 | ❌ | 内存中从 leafId 回溯 |
| `branch` | 内存 | ❌ | 只修改内存 leafId，不写文件 |
| `getLeafId` | 读 | ❌ | 读取内存 leafId |
| `updateSession` | 写 | ✅ Store 锁 | 写 sessions.json |
| `deleteSession` | 写 | ✅ Store 锁 | 写 sessions.json + 删 JSONL |

### 锁实现

per-file Promise 队列，确保同一个文件的写操作排队执行：

```typescript
// lock.ts
const locks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const current = locks.get(filePath) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  locks.set(filePath, next);

  try {
    await current;
    return await fn();
  } finally {
    resolve!();
    if (locks.get(filePath) === next) {
      locks.delete(filePath);
    }
  }
}
```

---

## 7. 核心流程

### 7.1 创建 Session

```
createSession(key, opts?)
  │
  ├─ withFileLock(storePath)
  │   ├─ 读取 sessions.json
  │   ├─ key 已存在? → 抛出错误
  │   ├─ 生成 sessionId（crypto.randomUUID）
  │   ├─ 创建 JSONL 文件，写入 session 首行记录：
  │   │   {"type":"session","id":"...","parentId":null,"timestamp":"...","version":1}
  │   ├─ 构建 SessionEntry
  │   └─ 写入 sessions.json
  │
  ├─ 初始化内存状态：
  │   ├─ byId = Map（session 记录）
  │   └─ leafId = session 记录的 id
  │
  └─ 返回 SessionEntry
```

### 7.2 追加消息

```
appendMessage(key, message)
  │
  ├─ 获取内存中的 leafId
  │
  ├─ 构建 MessageRecord：
  │   ├─ type = 'message'
  │   ├─ id = crypto.randomUUID()
  │   ├─ parentId = leafId          ← 树形关键：指向当前末端
  │   ├─ timestamp = new Date().toISOString()
  │   └─ message = { role, content }
  │
  ├─ withFileLock(jsonlPath)
  │   └─ appendFile(jsonlPath, JSON.stringify(record) + '\n')
  │
  ├─ 更新内存：
  │   ├─ byId.set(record.id, record)
  │   └─ leafId = record.id         ← 移动指针到新消息
  │
  └─ withFileLock(storePath)
      └─ 更新 updatedAt
```

### 7.3 获取当前分支消息

```
getMessages(key)
  │
  ├─ 获取内存中的 leafId 和 byId Map
  │
  ├─ 从 leafId 沿 parentId 回溯到根：
  │   path = []
  │   current = leafId
  │   while (current !== null) {
  │     entry = byId.get(current)
  │     if (entry.type === 'message') path.unshift(entry)
  │     current = entry.parentId
  │   }
  │
  └─ 返回 path（正序 MessageRecord[]）
```

### 7.4 分支

```
branch(key, entryId)
  │
  ├─ byId.has(entryId)? → 否则抛出错误
  │
  └─ leafId = entryId    ← 只修改内存指针，不写文件
  
  后续 appendMessage 的 parentId 将指向 entryId，
  形成新分��。旧分支的记录仍在 JSONL 文件中。
```

### 7.5 加载已有 Session

```
loadTranscript(sessionFile)
  │
  ├─ 逐行读取 JSONL
  │   ├─ JSON.parse 每行
  │   ├─ 存入 byId Map
  │   └─ 跳过空行/格式错误行
  │
  ├─ 确定 leafId：
  │   └─ 找到最后一条记录的 id（文件末尾）
  │
  └─ 返回 { byId, leafId }
```

---

## 8. 使用示例

### 基本用法

```typescript
import { SessionManager } from './session';

const manager = new SessionManager('./my-project');

// 创建 Session
const entry = await manager.createSession('main');

// 追加消息
await manager.appendMessage('main', { role: 'user', content: 'Hello' });
await manager.appendMessage('main', {
  role: 'assistant',
  content: [{ type: 'text', text: 'Hi! How can I help?' }],
});

// 读取当前分支的消息历史
const messages = manager.getMessages('main');
// → [{ type:'message', id:'...', parentId:'...', message: { role:'user', content:'Hello' }, ... }, ...]
```

### 分支操作（崩溃恢复）

```typescript
// 场景：上次崩溃，末尾留了一条孤立的 user 消息
const messages = manager.getMessages('main');
const last = messages[messages.length - 1];

if (last && last.message.role === 'user') {
  // 回退到父节点，丢弃孤立消息
  manager.branch('main', last.parentId!);
}

// 后续 appendMessage 从干净的位置继续
```

### 分支操作（换思路）

```typescript
// Turn 1-2：分析阶段
// Turn 3-5：方案 A（不满意）

// 回退到 Turn 2，从分析结果重新出发
manager.branch('main', turn2MessageId);

// Turn 3'-5'：方案 B，不受方案 A 影响
// 方案 A 的记录仍在 JSONL 文件中，可追溯
```

### Sub Agent

```typescript
const subEntry = await manager.createSession('subagent:file-task', {
  spawnedBy: 'main',
});

await manager.appendMessage('subagent:file-task', {
  role: 'user',
  content: 'Process these files',
});
```

### 与 Prompt Builder 配合

```typescript
import { SessionManager } from './session';
import { SystemPromptBuilder, UserPromptBuilder } from './prompt-builder';
import { loadContextFiles } from './workspace';

const session = new SessionManager('./my-project');
const contextFiles = await loadContextFiles('./my-project');

const systemPrompt = new SystemPromptBuilder().build({
  tools: [...],
  contextFiles,
});

const userPrompt = await new UserPromptBuilder().build({
  text: '帮我写个函数',
});

// 获取当前分支的历史消息
const history = session.getMessages('main');

// 发送给 LLM
const response = await callLLM({
  system: systemPrompt,
  messages: [
    ...history.map(m => m.message),
    { role: 'user', content: userPrompt.text },
  ],
});

// 持久化
await session.appendMessage('main', { role: 'user', content: userPrompt.text });
await session.appendMessage('main', { role: 'assistant', content: response.content });
```

---

## 9. 实施步骤

### Step 1 · types.ts
- [ ] SessionEntry 类型
- [ ] TranscriptEntryBase 类型（id + parentId + type + timestamp）
- [ ] SessionRecord / MessageRecord / CompactionRecord 类型
- [ ] ContentBlock 类型

### Step 2 · lock.ts
- [ ] `withFileLock()` — per-file Promise 队列

### Step 3 · store.ts
- [ ] `loadStore()` — 读取 sessions.json
- [ ] `saveStore()` — 写入 sessions.json（带锁）

### Step 4 · transcript.ts
- [ ] `loadTranscript()` — 读取 JSONL，构建 byId Map + 确定 leafId
- [ ] `appendToTranscript()` — 追加记录到 JSONL（带锁）

### Step 5 · SessionManager.ts
- [ ] `createSession()` / `getSession()` / `listSessions()`
- [ ] `appendMessage()` — parentId = leafId，追加后更新 leafId
- [ ] `getMessages()` — 从 leafId 沿 parentId 回溯
- [ ] `branch()` — 移动 leafId 指针
- [ ] `getLeafId()`
- [ ] `updateSession()` / `deleteSession()`

### Step 6 · index.ts
- [ ] 公共入口

---

## 10. 测试计���

### 10.1 lock.ts 测试

| 测试用例 | 预期行为 |
|---------|---------|
| 单次操作 | 正常执行 |
| 同一文件并发 | 排队执行，结果正确 |
| 不同文件并发 | 互不阻塞 |
| 操作抛出异常 | 锁正确释放，后续操作正常 |

### 10.2 store.ts 测试

| 测试用例 | 预期行为 |
|---------|---------|
| sessions.json 不存在 | 返回空对象 |
| 正常读写 | 写入后读取一致 |
| 并发写入 | 通过锁保证顺序，不丢数据 |

### 10.3 transcript.ts 测试

| 测试用例 | 预期行为 |
|---------|---------|
| JSONL 文件不存在 | 返回空 byId + leafId = null |
| 加载线性消息 | byId 包含所有记录，leafId 指向最后一条 |
| 加载含分支的消息 | byId 包含所有分支的记录 |
| 追加记录 | 文件末尾追加一行 |
| 空行 / 格式错误行 | 跳过，不���错 |
| 并发追加 | 通过锁保证顺序 |

### 10.4 SessionManager.ts 测试

**Session CRUD**：

| 测试用例 | 预期行为 |
|---------|---------|
| createSession | 生成 UUID，创建 JSONL（含 session 首行），写入 Store |
| createSession 重复 key | 抛出错误 |
| getSession 存在 | 返回 SessionEntry |
| getSession 不存在 | 返回 undefined |
| listSessions | 返回所有 Session |
| updateSession | 更新指定字段，其他字段不变 |
| deleteSession | 删除 Store 条目和 JSONL 文件 |
| deleteSession 不存在 | 不报错 |
| sub agent（spawnedBy） | 创建时设置 spawnedBy |

**消息操作（线性）**：

| 测试用例 | 预期行为 |
|---------|---------|
| appendMessage | 消息写入 JSONL，parentId = 当前 leafId |
| appendMessage 连续多条 | 形成链式 parentId → 线性 |
| getMessages | 返回当前分支的线性消息列表，正序 |
| getLeafId | 返回最后追加的消息 id |

**分支操作**：

| 测试用例 | 预期行为 |
|---------|---------|
| branch 到中间节点 | leafId 更新，后续 appendMessage 从该点展开 |
| branch 后 getMessages | 只返回从根到新 leafId 的路径，不含旧分支 |
| branch 后 appendMessage | 新消息的 parentId 指向 branch 目标 |
| branch 到不存在的 id | 抛出错误 |
| 多次 branch | leafId 正确跟踪 |

---

## 11. 后续可优化方向

| 能力 | 触发条件 | 参考 |
|------|---------|------|
| Store 缓存 | 读取频繁，磁盘 I/O 成为瓶颈 | OpenClaw `store-cache.ts` |
| 维护清理 | Session 数量/磁盘增长 | OpenClaw `store-maintenance.ts`（过期删除、条目限制、轮转） |
| 归档 | 删除的 Session 需要保留 | OpenClaw `archived/` 目录 |
| branchWithSummary | 分支时附带摘要，提供上下文 | pi-coding-agent `branchWithSummary()` |
| Transcript 预览 | UI 需要快速预览消息 | OpenClaw `readFirstUserMessageFromTranscript()` 等 |
| Session 重置策略 | 定时重置 Session（每日/每周） | OpenClaw `evaluateSessionFreshness()` |
