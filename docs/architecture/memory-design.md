# Memory 模块设计文档

> 创建日期：2026-04-07

---

## 1. 问题与动机

my-agent 目前只有 Session 级的对话存储（JSONL）。每次新会话启动，Agent 对之前的交互一无所知——无法记住用户的偏好、过去做过的决策、或者上周解决过的问题。

**我们需要一个跨会话的记忆系统**，让 Agent 能够：
- 积累长期知识（用户偏好、项目约定、关键决策）
- 记录短期上下文（每天的工作笔记、临时信息）
- 在需要时快速检索相关记忆
- 由 Agent 自主决定什么值得记住

### 1.1 不在 V1 范围内

- **自动记忆整理**（定时将高频短期记忆提升为长期记忆）— 需要先积累足够的使用数据
- **压缩前自动保存**（上下文窗口快满时自动提醒 Agent 保存重要信息）— 依赖尚未实现的 compaction 机制
- **对话历史搜索**（跨会话搜索过去的对话内容）— 可作为后续增强

### 1.2 配置边界

Memory 模块负责“如何索引、检索和维护记忆”，不负责“从哪里读取全局配置”。

因此，Memory 模块原则上不应直接访问 config：

- 不应直接调用 `loadConfig()` 或 `resolveAgentConfig()`；
- 不应通过 `process.env` 自行读取 embedding provider、数据库路径或搜索阈值等关键运行配置；
- 不应依赖完整 `AgentDefaults` 作为常规输入。

推荐的边界是：

- Runtime 层先完成配置解析；
- Runtime 将 memory 相关字段映射为 `MemoryConfig` 或更小的局部 options；
- Memory 模块只接收自己真正需要的配置子集，例如 `workspaceDir`、`dbPath`、`embedding`、`search`。

这样 Memory 才能保持为可测试、可替换的领域模块，而不是把全局配置结构带进索引、检索和文件写入逻辑中。

---

## 2. 记忆模型

### 2.1 两种记忆文件

| 文件 | 用途 | 特点 | 示例内容 |
|------|------|------|----------|
| `MEMORY.md` | 长期记忆 | 持久、精炼、由 Agent 主动维护 | "用户偏好 TypeScript strict mode"、"部署到 AWS us-east-1" |
| `memory/YYYY-MM-DD.md` | 每日笔记 | 按日期组织、追加写入、可能过时 | "今天修复了登录 bug #123"、"讨论了新的 API 设计" |

> **后续考虑**：目前短期笔记到长期记忆的提升完全靠 Agent 自主判断。后续可以借鉴类似 OpenClaw Dreaming 的机制——通过定时任务自动分析哪些短期笔记被频繁召回，将高价值内容自动整理到长期记忆中，减少对 Agent 主动性的依赖。

**设计选择：纯 Markdown 文件**

记忆存储为普通 Markdown 文件而非数据库记录，原因是：
- 人类可直接阅读和编辑
- 版本控制友好（可以 git 跟踪变化）
- Agent 用标准文件读写工具操作，无需专用 API
- 调试简单——打开文件就能看到 Agent 记住了什么

> **参考**：这种"文件即记忆"的方式借鉴了业界多个 Agent 框架的实践。Markdown 文件作为记忆源，SQLite 索引作为加速检索的辅助层。

### 2.2 索引层

Markdown 文件是记忆的"源头"，但直接搜索文本文件效率有限。因此我们额外维护一个 **SQLite 索引**，将文件内容分块后建立：
- **全文索引**（FTS5）— 精确匹配关键词、ID、错误码
- **向量索引**（嵌入）— 语义相似度搜索，理解同义词和释义

索引是派生数据，随时可以从 Markdown 文件重建。

### 2.3 存储布局

```
<workspaceDir>/
├── MEMORY.md                      # 长期记忆
├── memory/
│   ├── 2026-04-07.md              # 今天的笔记
│   └── 2026-04-06.md              # 昨天的笔记
└── .agent/
    ├── sessions/                  # 已有：Session 模块
    ├── memory.sqlite              # 索引库（向量 + 全文搜索）
    └── memory/
        └── .recalls/
            └── recall-log.jsonl   # 召回追踪日志
```

---

## 3. 架构

```
┌─────────────────────────────────────────────────────┐
│  Agent 工具层                                        │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────┐   │
│  │memory_search │ │ memory_get │ │ memory_write │   │
│  └──────┬───────┘ └─────┬──────┘ └──────┬───────┘   │
│         └───────────────┼───────────────┘            │
│                         │                            │
│                  ┌──────▼───────┐                     │
│                  │MemoryManager │  ← 统一入口         │
│                  └──────┬───────┘                     │
│        ┌────────────────┼────────────────┐           │
│        │                │                │           │
│  ┌─────▼──────┐  ┌──────▼──────┐  ┌──────▼───────┐  │
│  │  Searcher  │  │   Indexer   │  │RecallTracker │  │
│  │(混合搜索)  │  │(分块+嵌入)  │  │ (召回日志)   │  │
│  └─────┬──────┘  └──────┬──────┘  └──────────────┘  │
│        │                │                            │
│        └───────┬────────┘                            │
│                │                                     │
│       ┌────────▼────────┐   ┌──────────────────┐    │
│       │  SqliteStore    │   │EmbeddingProvider │    │
│       │  ├─ FTS5 索引   │   │ └─ Local (V1)    │    │
│       │  ├─ 向量 BLOB   │   │ └─ OpenAI (后续) │    │
│       │  └─ 元数据      │   └──────────────────┘    │
│       └─────────────────┘                            │
│                ▲ 分块 & 索引                          │
│       ┌────────┴────────┐                            │
│       │ Markdown 文件    │                            │
│       │ ├─ MEMORY.md    │                            │
│       │ └─ memory/*.md  │                            │
│       └─────────────────┘                            │
└─────────────────────────────────────────────────────┘
```

---

## 4. 目录结构

```
src/
└── memory/
    ├── index.ts                       # 公共导出（re-export）
    ├── types.ts                       # 所有接口和类型定义
    ├── MemoryManager.ts               # 统一入口
    ├── MemoryIndexer.ts               # 分块 + 嵌入 + 入库
    ├── MemorySearcher.ts              # 混合搜索
    ├── RecallTracker.ts               # 召回追踪
    ├── embedding/
    │   └── LocalEmbeddingProvider.ts  # 本地嵌入（@xenova/transformers）
    ├── store/
    │   └── sqlite-store.ts            # SQLite 存储实现
    └── tools/
        └── memory-tools.ts            # Agent 工具定义
```

命名规则（对齐编码规范 `coding-standards.md`）：
- 类文件 PascalCase：`MemoryManager.ts`、`LocalEmbeddingProvider.ts`
- 辅助模块 kebab-case：`sqlite-store.ts`、`memory-tools.ts`
- 接口统一放 `types.ts`，不单独建文件
- 核心类（Manager、Indexer、Searcher、Tracker）放模块根目录，可替换的实现（embedding provider、store、tools）按职责分子目录

---

## 5. 数据结构

### 5.1 MemoryChunk — 记忆块

记忆文件被切分为块后存入索引，每块是可独立检索的最小单元：

```typescript
interface MemoryChunk {
  id: string;              // "${source}:${path}:${startLine}-${endLine}"
  path: string;            // "MEMORY.md" 或 "memory/2026-04-07.md"
  source: string;          // 来源命名空间，V1 固定为 "memory"，后续可扩展 "sessions" 等
  content: string;         // 块文本
  startLine: number;       // 起始行（1-based）
  endLine: number;         // 结束行（1-based, inclusive）
  embedding?: number[];    // 向量（无嵌入能力时为 undefined）
  model?: string;          // 生成 embedding 的模型标识（如 "all-MiniLM-L6-v2"）
  updatedAt: number;       // 时间戳（ms）
}
```

> **关于 model 字段**：不同嵌入模型产出的向量维度和语义空间均不同（如 all-MiniLM-L6-v2 是 384 维，OpenAI text-embedding-3-small 是 1536 维），不能混用。记录 model 的用途：① 启动时检测 provider 是否切换，不一致则触发全量重建索引；② 搜索时只用当前模型的向量做相似度计算。

### 5.2 MemorySearchResult — 搜索结果

```typescript
interface MemorySearchResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;           // 0-1
  matchType: 'vector' | 'keyword' | 'hybrid';
}
```

### 5.3 RecallEntry — 召回记录

```typescript
interface RecallEntry {
  query: string;
  timestamp: string;       // ISO 8601
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
}
```

### 5.4 MemoryConfig — 配置

```typescript
interface MemoryConfig {
  workspaceDir: string;
  dbPath?: string;                   // 默认 .agent/memory.sqlite
  embedding?: {
    provider?: 'local' | 'openai';   // 默认 'local'
    model?: string;
  };
  search?: SearchOptions;
  enabled?: boolean;                 // 默认 true
}

interface SearchOptions {
  maxResults?: number;               // 默认 6
  minScore?: number;                 // 默认 0.25
  hybrid?: {
    vectorWeight?: number;           // 默认 0.7
    textWeight?: number;             // 默认 0.3
  };
}
```

---

## 6. SQLite Schema

```sql
-- 已索引文件的状态跟踪（用于增量索引：hash 不变则跳过）
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'memory',
  hash        TEXT NOT NULL,              -- 文件内容 SHA-256
  mtime       INTEGER NOT NULL,           -- 最后修改时间（ms）
  size        INTEGER NOT NULL            -- 文件大小（bytes）
);

-- 记忆块（分块后的文本 + 向量）
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,           -- "${source}:${path}:${startLine}-${endLine}"
  path        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'memory',
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  model       TEXT NOT NULL,              -- 嵌入模型标识，如 "all-MiniLM-L6-v2"
  content     TEXT NOT NULL,
  embedding   BLOB,                       -- Float32Array → Buffer，降级模式下为 NULL
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

-- 全文搜索（FTS5 独立表模式，含 UNINDEXED 元数据列用于过滤）
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,                                -- 唯一被索引的列
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  tokenize='unicode61'
);

-- 元数据（当前 provider+model 标识等运行时状态）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

**说明**：

- **files 表**：独立跟踪已索引文件的 hash/mtime/size，比用 meta 表存 hash 更清晰，也方便后续按 source 过滤文件。
- **FTS5 采用独立表模式**（非 content-sync 触发器模式）：FTS 表包含 UNINDEXED 元数据列（source、model 等），搜索时可直接在 FTS 查询中按这些列过滤，不需要 JOIN 回主表。代价是写入时需要手动同步两张表。
- **向量搜索**：V1 使用纯 JS 余弦相似度计算。从数据库加载当前 model 的含向量行，逐条计算相似度后排序。几百到几千条记忆块的规模下性能足够，后续可引入 SQLite 向量扩展。
- **全文搜索**：使用 FTS5 内置的 `bm25()` 排名函数。

---

## 7. 核心组件

### 7.1 EmbeddingProvider — 文本向量化

将文本转换为固定维度的数值向量，用于语义相似度计算。

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}
```

**V1 实现：LocalEmbeddingProvider**

使用 `@xenova/transformers` 在 Node.js 本地运行 `all-MiniLM-L6-v2` 模型（384 维）。无需外部 API Key。

关键行为：
- **懒加载**：首次调用 `embed()` 时才下载并初始化模型（首次约 10-30 秒，后续缓存在 `~/.cache/huggingface/`）
- **并发安全**：多个调用方同时触发初始化时，只执行一次
- **批量支持**：一次传入多条文本

**工厂函数**：

```typescript
async function createEmbeddingProvider(
  config?: MemoryConfig['embedding']
): Promise<EmbeddingProvider | null>
```

返回 null 表示无法创建（加载失败等），系统自动降级为纯关键词搜索。

**后续扩展**：可增加 `OpenAIEmbeddingProvider`（检测 `OPENAI_API_KEY`）、`VoyageEmbeddingProvider` 等远程实现。不同 provider 的向量维度不兼容，切换时需要全量重建索引。

### 7.2 sqlite-store — 持久化存储

```typescript
interface MemoryStore {
  upsertChunks(chunks: MemoryChunk[]): void;
  deleteByPath(path: string): void;
  searchByVector(embedding: number[], topK: number, model: string): Array<MemoryChunk & { score: number }>;
  searchByKeyword(query: string, topK: number): Array<MemoryChunk & { score: number }>;
  getFile(path: string): { hash: string; mtime: number; size: number } | undefined;
  upsertFile(path: string, info: { source: string; hash: string; mtime: number; size: number }): void;
  deleteFile(path: string): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  close(): void;
}
```

实现要点：

| 方法 | 说明 |
|------|------|
| `upsertChunks` | `INSERT OR REPLACE` 到 chunks 表 + 同步写入 chunks_fts 表 |
| `deleteByPath` | 删除 chunks 和 chunks_fts 中指定文件的所有块 |
| `searchByVector` | 加载指定 model 的向量 → 逐条余弦相似度 → topK |
| `searchByKeyword` | FTS5 `MATCH` + `bm25()` 排名 |
| `getFile/upsertFile` | 操作 files 表，用于增量索引的 hash 比对 |

使用 `better-sqlite3`（同步 API，性能好，无需 async 包装）。

### 7.3 MemoryIndexer — 分块与索引

将 Markdown 文件切分为可检索的块，生成向量，写入存储。

```typescript
class MemoryIndexer {
  constructor(store: MemoryStore, embeddingProvider: EmbeddingProvider | null)

  async indexFile(relativePath: string, content: string): Promise<void>
  async indexAll(workspaceDir: string): Promise<void>
  removeFile(relativePath: string): void
}
```

**分块策略**：
- 目标块大小：~1600 字符（约 400 tokens）
- 重叠：~320 字符（约 80 tokens），保证上下文不在块边界丢失
- 按行边界切分，不在行中间断开

**增量索引**：通过 `files` 表存储每个文件的内容 SHA-256 hash。文件未变时跳过，避免重复嵌入。

```
indexFile(path, content)
  │
  ├─ 计算 SHA-256 hash
  ├─ store.getFile(path) → 与存储的 hash 比对 → 相同则跳过
  │
  ├─ 按行边界切分为块
  ├─ 生成向量（有 provider 时）
  ├─ 删除该文件旧块
  ├─ 写入新块
  └─ store.upsertFile(path, { hash, mtime, size })
```

### 7.4 MemorySearcher — 混合搜索

同时利用语义相似度和关键词匹配来找到最相关的记忆。

```
search(query, options)
  │
  ├─ 有向量能力?
  │   ├─ Yes → 混合搜索
  │   └─ No  → 纯关键词搜索（自动降级）
  │
  ├─ [混合搜索]
  │   ├─ 查询文本 → 向量化
  │   ├─ 并行：向量搜索 + 关键词搜索
  │   ├─ 各自分数归一化到 0-1
  │   ├─ 加权合并：final = 0.7 × 向量分 + 0.3 × 关键词分
  │   ├─ 去重（同一块取最高分）
  │   └─ 排序 + 过滤 + 截取
  │
  ├─ [纯关键词搜索]
  │   └─ FTS5 搜索 → 过滤 → 截取
  │
  └─ 返回 MemorySearchResult[]
```

**为什么 0.7 / 0.3？**

向量搜索擅长理解意图（"之前讨论的部署方案" 能匹配到 "AWS us-east-1 部署配置"），但对精确的标识符（错误码、版本号、函数名）不如关键词搜索。7:3 的权重偏向语义理解，同时保留精确匹配能力。这个比例可通过配置调整。

### 7.5 RecallTracker — 召回追踪

每次搜索后异步记录"哪些记忆被查询、被命中"，为将来的记忆整理功能积累数据。

```typescript
class RecallTracker {
  constructor(recallDir: string)

  /** fire-and-forget，不阻塞搜索 */
  record(entry: RecallEntry): void
}
```

以 JSONL 格式追加到 `recall-log.jsonl`。V1 只写不读——数据留给将来的自动整理功能使用（例如：频繁被搜索到的短期笔记可能值得提升为长期记忆）。

---

## 8. Agent 工具

暴露三个工具给 Agent，遵循现有 `Tool` 接口（`src/tools/types.ts`）。

### 8.1 memory_search

搜索记忆中的相关信息。

```typescript
{
  name: 'memory_search',
  description: 'Search your memory for relevant information using semantic similarity and keyword matching.',
  inputSchema: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'What to search for.' },
      maxResults: { type: 'number', description: 'Max results. Default: 6.' },
      minScore:   { type: 'number', description: 'Min relevance (0-1). Default: 0.25.' },
    },
    required: ['query'],
  },
}
```

输出示例：
```
Found 2 results for "deploy config":

[1] MEMORY.md:15-22 (score: 0.87)
Production deploys to AWS us-east-1.
Use terraform apply from the infra/ directory.

[2] memory/2026-04-06.md:3-8 (score: 0.72)
Updated deploy pipeline to include smoke tests.
```

### 8.2 memory_get

读取指定记忆文件的内容。

```typescript
{
  name: 'memory_get',
  description: 'Read a memory file, optionally specifying a line range.',
  inputSchema: {
    type: 'object',
    properties: {
      path:  { type: 'string', description: 'e.g. "MEMORY.md" or "memory/2026-04-07.md".' },
      from:  { type: 'number', description: 'Start line (1-based). Optional.' },
      lines: { type: 'number', description: 'Number of lines. Optional.' },
    },
    required: ['path'],
  },
}
```

路径限制在 `MEMORY.md` 和 `memory/` 目录内。

### 8.3 memory_write

写入记忆内容。

```typescript
{
  name: 'memory_write',
  description: 'Save information to memory. Use MEMORY.md for lasting facts, memory/YYYY-MM-DD.md for daily notes.',
  inputSchema: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: '"MEMORY.md" or "memory/YYYY-MM-DD.md".' },
      content: { type: 'string', description: 'Content to write.' },
      mode:    { type: 'string', enum: ['append', 'overwrite'], description: 'Default: append.' },
    },
    required: ['path', 'content'],
  },
}
```

写入后自动触发该文件的增量重索引。

### 8.4 工厂函数

```typescript
function createMemoryTools(manager: MemoryManager): Tool[]
```

---

## 9. MemoryManager — 统一入口

```typescript
class MemoryManager {
  static async create(config: MemoryConfig): Promise<MemoryManager>

  async search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]>
  async readFile(path: string, from?: number, lines?: number): Promise<string>
  async writeFile(path: string, content: string, mode: 'append' | 'overwrite'): Promise<void>
  async reindex(): Promise<void>
  close(): void
}
```

**初始化流程**：

```
MemoryManager.create(config)
  │
  ├─ 尝试创建 EmbeddingProvider（失败则为 null → 降级搜索）
  ├─ 打开 SQLite（初始化 Schema）
  ├─ 创建 Indexer / Searcher / RecallTracker
  ├─ 首次索引所有记忆文件
  └─ 返回实例
```

---

## 10. 与现有模块的集成

### 10.1 SystemPromptBuilder

`buildMemorySection()`（第 150-173 行）已经预留了 memory 工具检测——只要工具注册了，系统提示词自动包含记忆使用指导。

后续可优化措辞，增加 `memory_write` 的引导。

### 10.2 AgentRunner

```typescript
const memoryManager = await MemoryManager.create({ workspaceDir });
const memoryTools = createMemoryTools(memoryManager);
const allTools = [...builtinTools, ...memoryTools];

// 构建 ToolExecutor（按工具名分发）
const toolMap = new Map(allTools.map(t => [t.name, t]));
const toolExecutor = async (name, input) => {
  const tool = toolMap.get(name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  return tool.execute(input);
};

const runner = new AgentRunner({ llmClient, sessionManager, toolExecutor });
```

### 10.3 启动顺序

```
应用启动
  ├─ SessionManager(workspaceDir)
  ├─ AnthropicClient({ apiKey })
  ├─ await MemoryManager.create(config)    ← 新增
  ├─ createMemoryTools(memoryManager)      ← 新增
  └─ AgentRunner({ ... })
```

---

## 11. 依赖

| 包 | 用途 |
|----|------|
| `better-sqlite3` | SQLite 数据库 + FTS5 全文搜索 |
| `@types/better-sqlite3` | TypeScript 类型（dev） |
| `@xenova/transformers` | 本地嵌入模型（all-MiniLM-L6-v2, 384 维） |

---

## 12. 实施步骤

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | `types.ts` — 全部接口定义 | 无 |
| 2 | `embedding/LocalEmbeddingProvider.ts` — 本地嵌入实现 | 步骤 1 |
| 3 | `store/sqlite-store.ts` — SQLite 存储实现 | 步骤 1 |
| 4 | `MemoryIndexer.ts` — 分块 + 嵌入 + 入库 | 步骤 2, 3 |
| 5 | `MemorySearcher.ts` — 混合搜索 | 步骤 2, 3 |
| 6 | `RecallTracker.ts` — 召回追踪 | 步骤 1 |
| 7 | `tools/memory-tools.ts` — memory_search / memory_get / memory_write | 步骤 5, 6 |
| 8 | `MemoryManager.ts` + `index.ts` | 步骤 2-7 |
| 9 | `package.json` 依赖 + 集成验证 | 步骤 8 |

---

## 13. 测试计划

### 13.1 单元测试

**LocalEmbeddingProvider**：
- 单条 / 批量 / 空数组嵌入
- 输出维度和归一化验证
- 懒加载和并发安全

**SqliteStore（sqlite-store.ts）**：
- CRUD 操作正确性
- FTS5 搜索匹配和排序
- 向量搜索余弦相似度排序
- 元数据读写

**MemoryIndexer**：
- 分块大小和重叠正确性
- 行边界切分
- 增量索引（hash 不变时跳过）
- 无 embedding provider 时正常工作

**MemorySearcher**：
- 混合搜索加权合并
- 无向量时降级为纯关键词搜索
- 分数归一化在 0-1 范围
- minScore 过滤和 maxResults 限制

**RecallTracker**：
- JSONL 追加正确性
- 目录自动创建
- 异步不阻塞

### 13.2 集成测试

| 场景 | 验证 |
|------|------|
| 写入 → 搜索 | `memory_write` 后 `memory_search` 能找到 |
| 写入 → 读取 | `memory_write` 后 `memory_get` 内容正确 |
| 搜索 → 召回记录 | 搜索后 `recall-log.jsonl` 有记录 |
| 路径安全 | `memory_get` / `memory_write` 拒绝越界路径 |
| 降级搜索 | 无 embedding 时纯关键词搜索正常 |

### 13.3 端到端验证

- AgentRunner + memory tools 完整对话
- Agent 自然使用 memory_write 保存信息
- 新会话中 Agent 用 memory_search 召回之前的信息

---

## 14. 后续演进方向

| 能力 | 前置条件 | 说明 |
|------|---------|------|
| 自动记忆整理 | 召回追踪数据积累 | 定时将高频召回的短期笔记提升为长期记忆 |
| 压缩前自动保存 | compaction 机制 | 上下文快满时提醒 Agent 保存重要信息 |
| 文件监听重索引 | 外部编辑需求 | 监听 memory 文件变化，自动更新索引 |
| 远程嵌入 | 需要更高搜索质量 | OpenAI / Voyage 等远程 API |
| 时间衰减 | 日记积累超 30 天 | 旧笔记降权，近期笔记优先 |
| 结果去冗余 | 搜索结果相似度高 | MMR（最大边际相关性）后处理 |
| 对话历史搜索 | 日常使用需求 | 索引过去的会话转录 |
