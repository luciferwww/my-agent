# OpenClaw Session 管理系统分析

> 分析日期：2026-04-02  
> 参考项目：C:\dev\my-agent\openclaw

---

## 1. 概述

OpenClaw 的 Session 管理由两层存储组成：

```
┌─────────────────────────────────────────┐
│     sessions.json（Session Store）       │
│  Key: sessionKey                        │
│  Value: SessionEntry（元数据）            │
│  ├─ sessionId                           │
│  ├─ sessionFile → 指向 Transcript       │
│  ├─ updatedAt、token 用量、成本等        │
│  └─ 模型、渠道、状态等运行时元数据        │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  {sessionId}.jsonl（Transcript）         │
│  ├─ 消息历史（role, content）            │
│  ├─ 压缩记录                            │
│  └─ 工具调用结果                         │
└─────────────────────────────────────────┘
```

**Session Store**（`sessions.json`）：所有 Session 的元数据索引，JSON 格式。  
**Session Transcript**（`{sessionId}.jsonl`）：单个 Session 的完整消息历史，JSONL 格式（每行一条记录）。

---

## 2. 数据结构

### 2.1 SessionEntry（元数据）

**定义文件**：`src/config/sessions/types.ts`

核心字段（精简后，去掉多渠道网关特有的）：

```typescript
type SessionEntry = {
  // 基础
  sessionId: string;               // 唯一 ID（UUID）
  updatedAt: number;               // 最后更新时间戳（ms）
  sessionFile?: string;            // JSONL 文件相对路径

  // 运行状态
  abortedLastRun?: boolean;        // 上次运行是否被中止
  status?: "running" | "done" | "failed" | "killed" | "timeout";

  // 模型配置
  model?: string;                  // 模型 ID
  modelProvider?: string;          // 提供商
  modelOverride?: string;          // 用户指定的模型覆盖
  providerOverride?: string;       // 用户指定的提供商覆盖

  // Token 统计
  contextTokens?: number;          // 上下文 token 数
  totalTokens?: number;            // 总 token 数
  inputTokens?: number;            // 输入 token
  outputTokens?: number;           // 输出 token
  estimatedCostUsd?: number;       // 成本估算

  // 压缩
  compactionCount?: number;        // 压缩执行次数

  // 运行时控制
  thinkingLevel?: string;          // 思考深度
  
  // 技能快照
  skillsSnapshot?: object;         // 技能配置快照
  systemPromptReport?: object;     // System Prompt 报告

  // 家族关系（sub agent）
  spawnedBy?: string;              // 父 Session Key
  spawnDepth?: number;             // 嵌套深度（0=主，1=子，2=孙）
};
```

### 2.2 Transcript 消息格式（JSONL）

每行一条 JSON 记录：

```jsonl
{"type":"session","id":"a1b2c3d4","cwd":"/home/user/project"}
{"id":"msg-001","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"id":"msg-002","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}
{"type":"compaction","id":"cmp-123","timestamp":"2026-04-01T12:00:00Z","reason":"overflow"}
{"id":"msg-003","message":{"role":"user","content":[{"type":"text","text":"Next question"}]}}
```

三种记录类型：

| 类型 | 说明 |
|------|------|
| `session` | Session 创建记录（首行） |
| 消息（无 type） | 用户/助手/工具的消息，有 `message` 字段 |
| `compaction` | 压缩记录，标记压缩发生的位置和原因 |

---

## 3. Session 生命周期

```
创建                使用                更新              压缩              清理
 │                   │                  │                 │                │
 ├─ 生成 sessionId   ├─ 加载 Store      ├─ token 统计     ├─ 溢出触发      ├─ >30 天删除
 ├─ 创建 JSONL 文件  ├─ 读取 JSONL      ├─ 模型记录       ├─ 总结历史      ├─ >500 条限制
 ├─ 写入 Store       ├─ 追加消息        ├─ 状态更新       ├─ 裁剪轮次      ├─ >10MB 轮转
 └─ 初始化元数据     └─ 调用 LLM        └─ 原子写入       └─ 更新 Store    └─ 磁盘配额
```

---

## 4. Session Key 命名规则

**定义文件**：`src/routing/session-key.ts`、`src/config/sessions/session-key.ts`

格式：`agent:{agentId}:{channel}:{scope}:{peerId}`

| 场景 | Session Key 示例 |
|------|------------------|
| 主 Session（DM 收敛） | `agent:main:main` |
| Per-peer DM | `agent:main:direct:user-123` |
| Per-channel-peer | `agent:main:slack:direct:user-123` |
| 群组 | `agent:main:slack:group:C123456` |
| Sub agent | `agent:main:subagent:task-abc` |
| Cron 任务 | `agent:main:cron:job-xyz` |

Session Key 的隔离粒度由配置驱动：

```json
{
  "session": {
    "scope": "per-sender",
    "mainKey": "main"
  },
  "channels": {
    "slack": { "dmScope": "per-peer" },
    "telegram": { "dmScope": "per-channel-peer" }
  }
}
```

---

## 5. 文件路径

```
~/.openclaw/agents/{agentId}/sessions/
├── sessions.json                       # Session Store（元数据索引）
├── {sessionId}.jsonl                   # Session Transcript（消息历史）
├── {sessionId}-topic-{topicId}.jsonl   # 线程 Transcript
├── archived/                           # 已删除的 Session 档案
│   ├── {sessionId}-deleted-{ts}.jsonl
│   └── {sessionId}-reset-{ts}.jsonl
└── sessions.backup-{ts}.json          # 轮转备份
```

关键解析函数：

| 函数 | 文件 | 用途 |
|------|------|------|
| `resolveAgentSessionsDir()` | `paths.ts` | → `~/.openclaw/agents/{agentId}/sessions` |
| `resolveDefaultSessionStorePath()` | `paths.ts` | → `.../sessions/sessions.json` |
| `resolveSessionTranscriptPath()` | `paths.ts` | → `.../sessions/{sessionId}.jsonl` |

---

## 6. Session 解析流程（resolveSession）

```
resolveSession({ cfg, to, sessionId, sessionKey, agentId })
  │
  ├─ 有 sessionKey? → 直接用 sessionKey 查 Store
  │
  ├─ 有 sessionId? → 遍历 Store 找匹配的 Session
  │
  ├─ 有 to（目标）? → 根据渠道规则生成 sessionKey
  │   └─ DM scope + channel + peerId → sessionKey
  │
  ├─ Store 中存在? → 返回已有 SessionEntry
  │
  └─ Store 中不存在? → 创建新 Session
      ├─ 生成 sessionId（UUID）
      ├─ 创建 JSONL 文件
      ├─ 初始化 SessionEntry
      └─ 写入 Store
```

---

## 7. 历史裁剪

**文件**：`src/agents/pi-embedded-runner/history.ts`

```typescript
// 从后往前数用户轮次，保留最后 N 轮
function limitHistoryTurns(messages, limit) {
  let userCount = 0;
  let lastUserIndex = messages.length;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);  // 截断
      }
      lastUserIndex = i;
    }
  }
  return messages;  // 未超限
}
```

限制值来自配置，按渠道/用户粒度配置：

```json
{
  "channels": {
    "slack": {
      "dmHistoryLimit": 10,
      "historyLimit": 5,
      "dms": {
        "user-123": { "historyLimit": 20 }
      }
    }
  }
}
```

优先级：per-user 覆盖 > dmHistoryLimit > historyLimit。

---

## 8. 对话压缩

**文件**：`src/agents/pi-embedded-runner/compact.ts`

### 触发条件

| 触发方式 | 条件 |
|---------|------|
| 自动（溢出） | 上下文 token 数 > 上下文窗口大小 |
| 手动 | 用户发送 `/compact` 命令 |
| 级联重试 | 压缩后仍然溢出 → 再次压缩 |

### 压缩流程

```
compactEmbeddedPiSession()
  │
  ├─ 加载 SessionManager
  ├─ 验证有可压缩内容（hasRealConversationContent）
  │
  ├─ compactWithSafetyTimeout()        ← 有超时保护（5-10 分钟）
  │   └─ 调用 LLM 生成历史摘要
  │
  ├─ limitHistoryTurns()               ← 裁剪历史轮次
  │
  ├─ 写入压缩记录到 JSONL
  │   └─ { type: "compaction", id, timestamp, reason, metrics }
  │
  └─ 更新 Session Store
      ├─ compactionCount++
      ├─ totalTokens 更新
      └─ totalTokensFresh = true
```

### 压缩配置（AgentCompactionConfig）

```typescript
{
  mode: "default" | "safeguard",
  reserveTokens: number,           // 压缩后预留 token 数
  keepRecentTokens: number,        // 保留最近多少 token
  recentTurnsPreserve: 3,          // 最近 3 轮不压缩
  customInstructions: string,      // 自定义压缩指令
  model: "claude-sonnet-...",      // 可以用专门的模型压缩
  timeoutSeconds: 900,             // 超时 15 分钟
}
```

---

## 9. Session Store 读写

**文件**：`src/config/sessions/store.ts`

```typescript
// 读取（带缓存 + 自动重试）
loadSessionStore(storePath): Record<string, SessionEntry>

// 原子写入（防并发冲突）
updateSessionStore(storePath, (store) => {
  store[sessionKey] = updatedEntry;
}): Promise<void>

// 带锁的同步队列
withSessionStoreLock(async () => {
  // 确保同一时间只有一个写操作
})
```

---

## 10. Session 维护（清理）

**文件**：`src/config/sessions/store-maintenance.ts`

| 操作 | 默认阈值 | 说明 |
|------|---------|------|
| `pruneStaleEntries()` | 30 天 | 删除超期 Session |
| `capEntryCount()` | 500 条 | 限制 Store 条目数 |
| `rotateSessionFile()` | 10 MB | 轮转过大的 JSONL 文件 |
| `enforceSessionDiskBudget()` | 配置驱动 | 磁盘配额管理 |
| `archiveRemovedSessionTranscripts()` | — | 删除的 Transcript 移到 archived/ |

---

## 11. 关键文件索引

### 数据结构与类型

| 文件 | 内容 |
|------|------|
| `src/config/sessions/types.ts` | SessionEntry 完整类型定义 |
| `src/config/sessions/session-key.ts` | Session Key 规范化 |
| `src/config/sessions/group.ts` | 群组 Session Key 解析 |

### 存储管理

| 文件 | 内容 |
|------|------|
| `src/config/sessions/store.ts` | Session Store CRUD（loadSessionStore / updateSessionStore） |
| `src/config/sessions/store-cache.ts` | Store 内存缓存 |
| `src/config/sessions/store-maintenance.ts` | 清理、轮转、配额 |
| `src/config/sessions/paths.ts` | 文件路径解析 |

### Session 生命周期

| 文件 | 内容 |
|------|------|
| `src/config/sessions/session-file.ts` | Session 文件创建和关联 |
| `src/gateway/session-utils.fs.ts` | JSONL 文件读写（readSessionMessages） |
| `src/gateway/sessions-resolve.ts` | Session 解析（resolveSessionKeyFromResolveParams） |

### 历史和压缩

| 文件 | 内容 |
|------|------|
| `src/agents/pi-embedded-runner/history.ts` | 历史裁剪（limitHistoryTurns） |
| `src/agents/pi-embedded-runner/compact.ts` | 对话压缩 |
| `src/agents/pi-embedded-runner/session-truncation.ts` | 压缩后文件清理 |
| `src/agents/context-window-guard.ts` | 上下文窗口计算 |
| `src/agents/pi-embedded-runner/session-manager-init.ts` | Session 初始化和修复 |
