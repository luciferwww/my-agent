# OpenClaw Memory 模块深度分析

> 分析日期: 2026-04-07
> 代码路径: `C:\dev\my-agent\openclaw`
> 参考文档: https://openclawlab.com/en/docs/concepts/memory/

---

## 目录

- [1. 核心设计理念](#1-核心设计理念)
- [2. 记忆类型（三层架构）](#2-记忆类型三层架构)
- [3. 架构总览](#3-架构总览)
- [4. 关键文件位置](#4-关键文件位置)
- [5. 核心接口](#5-核心接口)
- [6. 搜索机制](#6-搜索机制)
- [7. Agent 工具](#7-agent-工具)
- [8. Dreaming 系统](#8-dreaming-系统短期长期记忆提升)
- [9. Memory Flush（压缩前刷写）](#9-memory-flush压缩前刷写)
- [10. Embedding 提供者](#10-embedding-提供者)
- [11. 配置参考](#11-配置参考)
- [12. Memory 操作场景全景](#12-memory-操作场景全景)
  - [12.1 读取场景](#121-读取read场景)
  - [12.2 搜索场景](#122-搜索search场景)
  - [12.3 写入场景](#123-写入write场景)
  - [12.4 索引场景](#124-索引indexsync场景)
  - [12.5 清理场景](#125-清理维护cleanup场景)

---

## 1. 核心设计理念

Memory 采用 **"文件即真相"（Source-of-truth Markdown）** 的设计：

- 所有记忆以纯 Markdown 文件持久化到磁盘，而非保存在 RAM 中
- 模型"只记住写入磁盘的内容"
- 文件路径相对于 Agent 工作区（`~/.openclaw/workspace`）
- 向量索引存储在独立的 SQLite 数据库中（`~/.openclaw/memory/<agentId>.sqlite`）

---

## 2. 记忆类型（三层架构）

| 类型 | 文件 | 作用 | 加载时机 | 衰减 |
|------|------|------|----------|------|
| **长期记忆** | `MEMORY.md` | 策划的持久事实、偏好、决策 | 每次会话启动 | 常青，不衰减 |
| **短期记忆** | `memory/YYYY-MM-DD.md` | 每日追加的运行笔记和上下文 | 自动加载今天和昨天 | 指数衰减（半衰期 30 天） |
| **梦境日记** | `DREAMS.md` | Dreaming 阶段整合摘要（实验性） | 可选 | — |

内部追踪文件：

| 文件 | 作用 |
|------|------|
| `memory/.dreams/short-term-recall.json` | 召回频率/新近度追踪 |
| `memory/.dreams/phase-signals.json` | 巩固评分信号 |
| `memory/dreaming/<phase>/YYYY-MM-DD.md` | 可选的阶段报告 |

---

## 3. 架构总览

```
┌──────────────────────────────────────┐
│     Agent 上下文层                    │
│   (memory_search / memory_get 工具)  │
└──────────────┬───────────────────────┘
               │
        ┌──────▼───────┐
        │ SearchManager │  ← 路由工厂层
        └──────┬───────┘
     ┌─────────┼─────────────┐
     │         │             │
┌────▼────┐ ┌──▼──────┐ ┌───▼────────┐
│ Builtin │ │   QMD   │ │Supplements │
│ Manager │ │ Manager │ │ (Wiki/外部) │
└────┬────┘ └────┬────┘ └────────────┘
     │           │
┌────▼────────┐  └─ 启动 QMD 子进程
│ SQLite Index│
│ ├─ FTS5     │  (全文搜索)
│ ├─ Vectors  │  (向量语义搜索)
│ └─ Metadata │
└─────────────┘
     ▲  分块 & 索引（~400 token, 80 token 重叠）
     │
┌────┴────────────────┐
│ Memory 文件          │
│ ├─ MEMORY.md        │  ← 长期记忆（常青）
│ ├─ memory/*.md      │  ← 短期日记（按日期）
│ └─ sessions (可选)  │  ← 会话转录
└─────────────────────┘
     │
     │ Dreaming 系统监控 & 提升
     ▼
┌─────────────────────┐
│ Dreaming 系统        │
│ ├─ Light Phase      │  ← 浅睡：去重 & 排序
│ ├─ Deep Phase       │  ← 深睡：评分 & 提升到 MEMORY.md
│ └─ REM Phase        │  ← REM：反思 & 主题总结
└─────────────────────┘
```

---

## 4. 关键文件位置

### 核心实现

| 路径 | 职责 |
|------|------|
| `extensions/memory-core/index.ts` | 主记忆插件入口，注册工具/CLI/Dreaming |
| `extensions/memory-core/src/memory/manager.ts` | `MemoryIndexManager` — SQLite 索引管理 |
| `extensions/memory-core/src/memory/manager-search.ts` | 关键字和向量搜索实现 |
| `extensions/memory-core/src/memory/hybrid.ts` | 混合搜索结果合并 |
| `extensions/memory-core/src/memory/embeddings.ts` | Embedding 提供者抽象层 |
| `extensions/memory-core/src/memory/search-manager.ts` | 搜索管理器工厂 & 路由 |
| `extensions/memory-core/src/memory/qmd-manager.ts` | QMD 后端实现 |
| `extensions/memory-core/src/memory/manager-sync-ops.ts` | 文件监听、同步、索引操作 |
| `extensions/memory-core/src/memory/manager-reindex-state.ts` | Provider 变更检测与重建索引 |

### 工具 & CLI

| 路径 | 职责 |
|------|------|
| `extensions/memory-core/src/tools.ts` | `memory_search` / `memory_get` 工具实现 |
| `extensions/memory-core/src/tools.shared.ts` | 工具可用性门控 |
| `extensions/memory-core/src/cli.ts` | CLI 命令实现 |
| `extensions/memory-core/src/prompt-section.ts` | 系统提示词 Memory 段落注入 |

### Dreaming & 提升

| 路径 | 职责 |
|------|------|
| `extensions/memory-core/src/dreaming.ts` | Cron 任务 & 阶段编排 |
| `extensions/memory-core/src/dreaming-phases.ts` | 三阶段实现细节 |
| `extensions/memory-core/src/dreaming-narrative.ts` | 摘要叙事生成 |
| `extensions/memory-core/src/dreaming-command.ts` | 手动 Dreaming CLI |
| `extensions/memory-core/src/short-term-promotion.ts` | 召回追踪 & 提升逻辑 |
| `extensions/memory-core/src/concept-vocabulary.ts` | 概念标签提取 |

### Host SDK & 集成

| 路径 | 职责 |
|------|------|
| `src/memory-host-sdk/host/types.ts` | `MemorySearchManager` 接口定义 |
| `src/memory-host-sdk/engine-storage.ts` | 存储契约 |
| `src/auto-reply/reply/memory-flush.ts` | 压缩前记忆刷写 |
| `src/auto-reply/reply/agent-runner-memory.ts` | 记忆上下文注入 |
| `src/agents/memory-search.ts` | 记忆搜索工具注册 |
| `src/config/types.memory.ts` | 配置类型定义 |
| `src/plugins/` | 记忆运行时 & 状态管理 |

---

## 5. 核心接口

### MemorySearchManager — 搜索管理器

```typescript
interface MemorySearchManager {
  search(query: string, opts?): Promise<MemorySearchResult[]>
  readFile(params): Promise<{ text: string, path: string }>
  status(): MemoryProviderStatus
  sync(params?): Promise<void>
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>
  probeVectorAvailability(): Promise<boolean>
  close?(): Promise<void>
}
```

### MemorySearchResult — 搜索结果

```typescript
interface MemorySearchResult {
  path: string              // 文件路径
  startLine: number         // 起始行
  endLine: number           // 结束行
  score: number             // 相关度分数
  snippet: string           // 内容摘要（~700 字符上限）
  source: "memory" | "sessions"  // 来源
  citation?: string         // 引用标注
}
```

### 插件注册 API

```typescript
registerMemoryRuntime(runtime: MemoryPluginRuntime)
registerMemoryCorpusSupplement(pluginId, supplement)
registerMemoryPromptSection(builder)
registerMemoryFlushPlan(resolver)
```

---

## 6. 搜索机制

### 三种搜索策略

| 搜索类型 | 原理 | 优势场景 |
|----------|------|----------|
| **向量搜索** | 嵌入余弦相似度 | 同义词、释义、语义匹配 |
| **BM25 关键词搜索** | FTS5 全文索引 | 精确 ID、错误码、代码符号 |
| **混合搜索**（默认） | 加权合并 | 兼顾两者优势 |

### 分数合并公式

```
finalScore = vectorWeight × vectorScore + textWeight × textScore
```

默认权重: `vectorWeight = 0.7`, `textWeight = 0.3`

### 后处理增强

| 特性 | 公式/说明 | 默认状态 |
|------|----------|----------|
| **时间衰减** | `score × e^(-λ × ageInDays)`，半衰期 30 天 | 可选（`temporalDecay.enabled`） |
| **MMR** | 最大边际相关性，减少冗余 | 可选（`mmr.enabled`，λ=0.7） |

> `MEMORY.md` 是"常青文件"，跳过时间衰减。

### 分块策略

- 分块大小: ~400 token
- 重叠: 80 token
- 嵌入缓存: 提升重建索引性能

---

## 7. Agent 工具

### memory_search — 语义搜索

```
参数:
  - query: string        (必须) 搜索查询
  - maxResults: number   (可选) 最大结果数，默认 6
  - minScore: number     (可选) 最低分数，默认 0.35
  - corpus: string       (可选) "memory" | "wiki" | "all"

返回: MemorySearchResult[]（带分数和摘要）
副作用: 异步记录召回追踪（为 Dreaming 积累数据）
```

### memory_get — 安全文件读取

```
参数:
  - path: string         (必须) 工作区相对路径
  - from: number         (可选) 起始行
  - lines: number        (可选) 行数
  - corpus: string       (可选) 语料库参数

返回: { text: string, path: string }
安全: 拒绝工作区外路径
```

### 工具可用性门控

工具注册在 `resolveMemoryToolContext()` 中受条件控制：
- `memorySearch.enabled` 必须为 true
- Agent 必须有记忆配置
- 否则工具不注册（返回 null）

### 引用模式

`memory.citations`: `"auto"` | `"on"` | `"off"` — 控制搜索结果是否包含源文件引用标注。

---

## 8. Dreaming 系统（短期→长期记忆提升）

模仿人类睡眠中的记忆巩固过程，通过三个阶段将高价值短期记忆自动提升为长期记忆。

### 三阶段流程

| 阶段 | 作用 | 写入 MEMORY.md | 标记 |
|------|------|---------------|------|
| **Light（浅睡）** | 读取近期日记 + 召回追踪，去重排序候选 | ❌ | `<!-- openclaw:dreaming:light:start/end -->` |
| **Deep（深睡）** | 多维度评分，合格项提升到长期记忆 | ✅ | — |
| **REM（快速眼动）** | 主题反思和叙事总结 | ❌ | `<!-- openclaw:dreaming:rem:start/end -->` |

### Deep 阶段 — 6 维度加权评分

| 维度 | 权重 | 说明 |
|------|------|------|
| **Relevance**（相关性） | 0.30 | 搜索相关分数 |
| **Frequency**（频率） | 0.24 | 被召回的次数 |
| **Diversity**（多样性） | 0.15 | 查询来源多样性 |
| **Recency**（新鲜度） | 0.15 | 时间新近性 |
| **Consolidation**（巩固度） | 0.10 | 经历阶段的成熟度 |
| **Conceptual**（概念性） | 0.06 | 概念标签覆盖率 |

### 提升阈值

| 参数 | 默认值 |
|------|--------|
| 最低综合分数 | 0.75 |
| 最少召回次数 | 3 |
| 最少独立查询数 | 2 |
| 新近度半衰期 | 14 天 |
| 最大年龄 | 16 天 |

### 触发方式

| 方式 | 说明 |
|------|------|
| **Cron 定时** | 托管 Cron 任务，默认每日凌晨（如 `0 3 * * *`） |
| **手动 CLI** | `openclaw memory dream` 或 `openclaw memory promote` |
| **内部标签** | `[managed-by=memory-core.dreaming.light]`、`[managed-by=memory-core.dreaming.rem]`、`[managed-by=memory-core.short-term-promotion]` |

### 配置

```javascript
memory.dreaming: {
  enabled: false,           // 默认关闭，需手动开启
  cron: "0 3 * * *",       // Cron 表达式
  timezone: "America/New_York",
  limit: 5,                // 每阶段最大候选数
  minScore: 0.75,
  minRecallCount: 3,
  minUniqueQueries: 2,
  recencyHalfLifeDays: 14
}
```

---

## 9. Memory Flush（压缩前刷写）

### 目的

防止上下文压缩（compaction）导致关键信息丢失。在压缩前触发一轮"静默 Agent 回合"，提醒模型保存重要记忆。

### 触发条件

| 条件 | 公式/阈值 | 默认值 |
|------|----------|--------|
| **软阈值** | `totalTokens >= contextWindow - reserveTokensFloor - softThresholdTokens` | ~70% 上下文窗口 |
| **强制刷写** | 转录超过 `forceFlushTranscriptBytes` | 2MB |

### 去重机制

- **哈希去重**: SHA-256 对最近 3 条用户/助手消息 + 消息计数计算 hash（截取 16 位 hex）
- **周期限制**: `hasAlreadyFlushedForCurrentCompaction()` 确保每次压缩周期只触发一次
- **写入目标**: `memory/YYYY-MM-DD.md`（追加，不覆盖）
- **安全约束**: `MEMORY.md`、`DREAMS.md`、`SOUL.md`、`TOOLS.md`、`AGENTS.md` 为只读提示

### 配置

```javascript
compaction: {
  memoryFlush: {
    enabled: true,
    softThresholdTokens: 4000,
    forceFlushTranscriptBytes: 2097152,  // 2MB
    prompt: "...",                        // 自定义刷写提示
    systemPrompt: "..."                   // 自定义系统提示
  }
}
```

---

## 10. Embedding 提供者

### 自动检测顺序

```
Local → OpenAI → Gemini → Voyage → Mistral → Bedrock → 禁用
```

### 提供者一览

| 提供者 | 默认模型 | 特点 |
|--------|---------|------|
| **OpenAI** | `text-embedding-3-small` | 默认首选，支持批量 API |
| **Gemini** | — | 支持多模态（图片 + 音频） |
| **Local** | GGUF (~0.6GB) | 完全离线，无需 API Key |
| **Voyage** | — | 高质量嵌入 |
| **Mistral** | — | 企业级 |
| **Bedrock** | Titan / Cohere / TwelveLabs | AWS 原生 |
| **Ollama** | — | 社区模型 |

### 容错机制

- **主备切换**: 指定 primary provider + fallback adapter
- **自动回退**: 主提供者首次出错后自动切换到备用
- **嵌入缓存**: 避免重复计算，提升重建索引速度

---

## 11. 配置参考

### 完整配置结构

```javascript
// agents.defaults.memorySearch 或 agents.<agentId>.memorySearch
memorySearch: {
  // --- 基本开关 ---
  enabled: true,
  backend: "builtin",              // "builtin" | "qmd"

  // --- Embedding 提供者 ---
  provider: "auto",                // "openai"|"gemini"|"local"|"voyage"|"mistral"|"bedrock"|"ollama"|"auto"
  model: "text-embedding-3-small",
  fallback: "local",               // 备用提供者

  remote: {
    baseUrl: undefined,
    apiKey: undefined,
    headers: {},
    batch: false                   // 批量嵌入 API
  },
  local: {
    modelPath: undefined,
    modelCacheDir: undefined
  },

  // --- 存储 ---
  store: {
    driver: "sqlite",
    path: "~/.openclaw/memory/{agentId}.sqlite",
    fts: { tokenizer: "unicode61" },  // "unicode61" | "trigram"
    vector: {
      enabled: true,
      extensionPath: undefined
    }
  },

  // --- 分块 ---
  chunking: {
    tokens: 400,
    overlap: 80
  },

  // --- 搜索行为 ---
  query: {
    maxResults: 6,
    minScore: 0.35,
    hybrid: {
      enabled: true,
      vectorWeight: 0.7,
      textWeight: 0.3,
      mmr: { enabled: false, lambda: 0.7 },
      temporalDecay: { enabled: false, halfLifeDays: 30 }
    }
  },

  // --- 同步 ---
  sync: {
    onSessionStart: true,          // 首次搜索时同步
    onSearch: true,                // 每次搜索时异步同步
    watch: true,                   // 文件监听
    watchDebounceMs: 1500,         // 监听防抖
    intervalMinutes: undefined,    // 定时轮询间隔
    sessions: {
      deltaBytes: 102400,         // ~100KB
      deltaMessages: 50,
      postCompactionForce: true
    }
  },

  // --- 额外路径 ---
  extraPaths: [],                  // 索引工作区外的目录

  // --- 多模态 (Gemini) ---
  multimodal: {
    enabled: false,
    modalities: ["image", "audio"],
    maxFileBytes: undefined
  },

  // --- 引用 ---
  citations: "auto"                // "auto" | "on" | "off"
}
```

---

## 12. Memory 操作场景全景

### 场景全景总结

下图以 Agent 生命周期为轴，将全部 18 个操作场景按运行阶段分组，编号与后续详细章节一一对应：

```
┌───────────────────── Agent 运行时 ─────────────────────────────────────────┐
│                                                                            │
│  [读取 Read]                                                               │
│    场景1  会话启动      ──→ 加载 MEMORY.md + 今天/昨天 memory/YYYY-MM-DD.md │
│    场景2  Prompt 构建   ──→ 注入 ## Memory Recall 指导段落                  │
│    场景3  memory_get    ──→ Agent 精确读取指定文件+行范围                    │
│                                                                            │
│  [搜索 Search]                                                             │
│    场景4  memory_search ──→ 混合搜索(向量+BM25) + 异步召回追踪(→场景8)      │
│    场景5  On-Search Sync──→ 搜索时后台异步更新脏索引                        │
│    场景6  Dreaming 预搜 ──→ 为提升评分搜索候选记忆                          │
│                                                                            │
│  [写入 Write]                                                              │
│    场景7  Memory Flush  ──→ 压缩前静默回合，写入 memory/YYYY-MM-DD.md       │
│    场景8  Recall Track  ──→ 每次搜索后异步写 short-term-recall.json         │
│    场景9  Dreaming Deep ──→ 高分条目提升到 MEMORY.md                        │
│                                                                            │
├───────────────────── 后台守护 ─────────────────────────────────────────────┤
│                                                                            │
│  [索引 Index/Sync]                                                         │
│    场景10 文件监听      ──→ 1.5s 防抖后增量重建索引                         │
│    场景11 会话转录同步  ──→ 5s 防抖，按 deltaBytes/Messages 阈值同步        │
│    场景12 定时轮询      ──→ intervalMinutes 间隔后台同步                     │
│    场景13 配置/Provider ──→ scope hash 变化时全量重建索引                    │
│    场景14 手动 CLI      ──→ openclaw memory index --force                   │
│                                                                            │
├───────────────────── 定时任务 ─────────────────────────────────────────────┤
│                                                                            │
│    场景9  Dreaming Cron ──→ Light → Deep → REM 三阶段记忆巩固               │
│           Deep 阶段     ──→ 6维评分，合格条目写入 MEMORY.md                 │
│                                                                            │
├───────────────────── 维护清理 ─────────────────────────────────────────────┤
│                                                                            │
│    场景15 过期锁清理    ──→ >60s 未释放的锁自动清除                         │
│    场景16 无效条目修复  ──→ repair 移除无效路径/重建损坏 store               │
│    场景17 索引同步清理  ──→ 全量 sync 时删除已不存在文件的索引条目           │
│    场景18 Provider 清理 ──→ Provider 切换时清除不兼容嵌入缓存               │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

### 12.1 读取（Read）场景

#### 场景 1: 会话启动 — 加载记忆上下文

- **文件**: `extensions/memory-core/src/memory/manager.ts`
- **触发**: 会话中第一次调用 `memory_search` 时执行 `warmSession(sessionKey)`
- **条件**: `sync.onSessionStart === true`
- **操作**: 调用 `sync({ reason: "session-start" })`，将 `MEMORY.md` + 今天/昨天的 `memory/YYYY-MM-DD.md` 加载并建立索引

#### 场景 2: 系统提示词注入 — Prompt Section 构建

- **文件**: `extensions/memory-core/src/prompt-section.ts`
- **触发**: 每次为 Agent 构建系统提示词时
- **操作**: 注入 `## Memory Recall` 指导段落，提醒 Agent 在回答关于过往工作、决策、偏好等问题前先搜索记忆
- **内容**: 引导 Agent 使用 `memory_search` 搜索 `MEMORY.md` + `memory/*.md`，然后用 `memory_get` 拉取需要的行

#### 场景 3: Agent 显式读取 — memory_get 工具

- **文件**: `extensions/memory-core/src/tools.ts`
- **触发**: Agent 主动调用 `memory_get` 工具，传入路径和行范围
- **操作**: 通过 `getSupplementMemoryReadResult()` 读取指定 memory 文件的精确内容
- **安全**: 拒绝工作区外路径

---

### 12.2 搜索（Search）场景

#### 场景 4: Agent 显式搜索 — memory_search 工具

- **文件**: `extensions/memory-core/src/tools.ts`
- **触发**: Agent 主动调用 `memory_search(query, options)`
- **操作**:
  1. 执行混合搜索（向量 + BM25）
  2. 返回带分数和摘要的结果
  3. **副作用**: 异步、非阻塞地记录召回追踪到 `memory/.dreams/short-term-recall.json`（为 Dreaming 系统积累数据）

#### 场景 5: 搜索时异步同步 — On-Search Sync

- **文件**: `extensions/memory-core/src/memory/manager.ts`
- **触发**: 每次 `search()` 调用时，如果索引标记为脏
- **条件**: `sync.onSearch === true`
- **操作**: 后台异步 `startAsyncSearchSync()`，不阻塞搜索结果返回但更新索引
- **目的**: 确保后续搜索命中最新内容

#### 场景 6: Dreaming 前的预搜索

- **文件**: `extensions/memory-core/src/short-term-promotion.ts`
- **触发**: Dreaming 阶段执行前
- **操作**: 搜索候选记忆以进行提升评分
- **评分维度**: Relevance, Frequency, Recency, Diversity, Consolidation, Conceptual

---

### 12.3 写入（Write）场景

#### 场景 7: 压缩前记忆刷写 — Memory Flush

- **文件**: `src/auto-reply/reply/memory-flush.ts` + `extensions/memory-core/src/flush-plan.ts`
- **触发条件**:
  - **软阈值**: `totalTokens >= contextWindow - reserveTokensFloor - softThresholdTokens`（约占满上下文窗口的 ~70%）
  - **强制刷写**: 会话转录超过 `forceFlushTranscriptBytes`（默认 2MB）
- **去重**: SHA-256 哈希（最近 3 条消息 + 消息计数），每次压缩周期只触发一次
- **操作**: 系统运行一轮"静默 Agent 回合"，提示 Agent "立即保存重要记忆"
- **写入目标**: `memory/YYYY-MM-DD.md`（追加，不覆盖）
- **安全约束**: `MEMORY.md`、`DREAMS.md`、`SOUL.md` 等为只读提示

#### 场景 8: 召回追踪记录 — Recall Tracking

- **文件**: `extensions/memory-core/src/short-term-promotion.ts`
- **触发**: 每次 `memory_search` 执行完毕后（异步、非阻塞）
- **操作**: `recordShortTermRecalls()` 更新追踪数据
- **写入目标**: `memory/.dreams/short-term-recall.json`
- **记录内容**:
  - 查询哈希（去重相似查询）
  - 结果路径、行号
  - 分数（搜索排名）
  - 召回计数、每日计数
  - 首次/末次召回时间戳
  - 概念标签（由 `deriveConceptTags()` 从内容中提取）
- **并发安全**: 文件锁（`memory/.dreams/short-term-promotion.lock`），超时 10s，重试 40ms，过期检测 60s

#### 场景 9: Dreaming 深睡阶段 — 短期→长期提升

- **文件**: `extensions/memory-core/src/dreaming-phases.ts` + `short-term-promotion.ts`
- **触发**: Cron 定时任务（默认凌晨）或手动 CLI 命令
- **操作流程**:
  1. 读取 `memory/.dreams/short-term-recall.json` 中的召回记录
  2. 对每个候选项进行 6 维度加权评分
  3. 通过阈值（分数≥0.75, 召回≥3次, 独立查询≥2个）的条目提升
  4. 写入阶段标记: `<!-- openclaw:dreaming:light:start -->` 等
- **写入目标**:
  - `MEMORY.md` — 追加永久记忆（仅 Deep 阶段）
  - `DREAMS.md` — 阶段摘要报告
  - `memory/.dreams/phase-signals.json` — 巩固评分信号

---

### 12.4 索引（Index/Sync）场景

#### 场景 10: 文件监听自动同步 — File Watcher

- **文件**: `extensions/memory-core/src/memory/manager-sync-ops.ts`
- **触发**: 文件系统 `add` / `change` / `unlink` 事件
- **监听目标**:
  - `MEMORY.md`, `memory.md`（工作区根目录）
  - `memory/**/*.md`（所有日记）
  - `extraPaths` 配置的额外路径
  - 多模态文件（图片/音频，如启用 Gemini）
- **忽略目录**: `.git`, `node_modules`, `.venv`, `__pycache__` 等
- **防抖**: `watchDebounceMs`（默认 1500ms）
- **操作**: `scheduleWatchSync()` → `sync({ reason: "watch" })` → 增量重建索引

#### 场景 11: 会话转录同步 — Session Transcript Sync

- **文件**: `extensions/memory-core/src/memory/manager-sync-ops.ts`
- **触发**: `onSessionTranscriptUpdate()` 事件监听
- **防抖**: 5000ms
- **阈值**: `deltaBytes` / `deltaMessages` / `postCompactionForce`
- **操作**: `processSessionDeltaBatch()` → `sync({ reason: "session-delta" })`

#### 场景 12: 定时轮询同步 — Interval Sync

- **文件**: `extensions/memory-core/src/memory/manager-sync-ops.ts`
- **触发**: 周期定时器，按 `sync.intervalMinutes` 间隔
- **操作**: 后台 `sync({ reason: "interval" })`，不阻塞操作

#### 场景 13: 配置/Provider 变更 — 全量重建

- **文件**: `extensions/memory-core/src/memory/manager-reindex-state.ts`
- **触发条件**:
  - Embedding provider 切换（不同模型向量不兼容）
  - Embedding model 变更
  - `extraPaths` 配置变化
  - 多模态设置切换
  - 搜索源增减（sessions index）
- **检测**: `shouldRunFullMemoryReindex()` 通过 scope hash 比对
- **操作**: 清除全部索引，全量重建

#### 场景 14: 手动 CLI 命令

```bash
openclaw memory index --force   # 绕过缓存，强制全量重建
openclaw memory status          # 检查索引和 Provider 状态
openclaw memory search "query"  # 命令行搜索
openclaw memory promote         # 手动触发 Dreaming 提升
openclaw memory dream           # 手动触发 Dreaming 全流程
```

---

### 12.5 清理/维护（Cleanup）场景

#### 场景 15: 过期锁清理

- **文件**: `extensions/memory-core/src/short-term-promotion.ts`
- **条件**: 锁文件超过 60 秒未释放
- **操作**: 自动检测并清除过期锁

#### 场景 16: 无效条目修复

- **触发**: `repairShortTermPromotionArtifacts()` — 手动 CLI 或审计检测
- **操作**: 移除路径已无效的条目，损坏时重建 store，清除过期锁
- **CLI**: `openclaw memory promote --repair`

#### 场景 17: 索引同步清理

- **文件**: `extensions/memory-core/src/memory/manager-sync-ops.ts`
- **触发**: 全量 sync 操作期间
- **操作**: 删除磁盘上已不存在的文件对应的 chunks、FTS 表、vector 表条目

#### 场景 18: Provider 状态清理

- **触发**: Provider 初始化或回退切换时
- **操作**: 清除缓存的不兼容嵌入状态，防止不同模型的向量混用

---

## 附录: CLI 命令速查

| 命令 | 作用 |
|------|------|
| `openclaw memory status` | 检查索引状态和 Provider |
| `openclaw memory search "query"` | 命令行语义搜索 |
| `openclaw memory index --force` | 强制全量重建索引 |
| `openclaw memory promote` | 手动触发短期→长期提升 |
| `openclaw memory promote --repair` | 修复损坏的提升追踪数据 |
| `openclaw memory dream` | 手动触发 Dreaming 全流程 |
| `openclaw memory rem-harness` | 查看 REM 阶段反思 |
| `/dreaming status\|on\|off\|help` | Dreaming 系统管理 |
