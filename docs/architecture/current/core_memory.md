# Core Memory 模块设计文档

> 文档日期：2026-05-29
> 关联文档：`platform_config.md` · `runtime.md`

---

## 1. 概述

`src/core/memory/` 提供语义记忆能力：把工作区内的 Markdown 文件切块、嵌入（向量化）后存入 SQLite，支持向量搜索 + 关键词搜索的混合召回。LLM 通过三个内置工具（`memory_search` / `memory_get` / `memory_write`）访问。

Memory 是**可选能力**：初始化失败时 runtime 降级为 null，不注入 memory 工具，应用继续启动。

---

## 2. 目录结构

```
src/core/memory/
├── types.ts              # EmbeddingProvider / MemoryChunk / MemorySearchResult
│                         # MemoryStore / MemoryConfig / RecallEntry
├── MemoryManager.ts      # 统一入口（异步工厂方法 create()）
├── memory-tools.ts       # createMemoryTools()：生成三个 Tool 实例
└── internal/
    ├── sqlite-store.ts      # MemoryStore 的 SQLite 实现
    ├── LocalEmbeddingProvider.ts   # 本地嵌入（Xenova/Transformers.js）
    ├── MemoryIndexer.ts     # 文件切块 + 嵌入 + 写入 Store
    ├── MemorySearcher.ts    # 混合搜索（向量 + BM25）
    └── RecallTracker.ts     # 搜索历史记录（异步写入 .agent/memory/.recalls/）
```

---

## 3. 组件职责

```
MemoryManager（统一入口）
  ├─ MemoryIndexer    ← 文件 → 切块 → 嵌入 → SQLite
  ├─ MemorySearcher   ← query → 向量搜索 + BM25 → 混合排名
  ├─ RecallTracker    ← 记录每次搜索的 query + 命中结果（异步，不阻塞搜索）
  └─ EmbeddingProvider ← 本地模型（Xenova/all-MiniLM-L6-v2, 384 维）
                         失败时为 null → 降级为纯关键词搜索
```

---

## 4. 关键类型

### 4.1 MemoryChunk

```
MemoryChunk {
  id: string           // '{source}:{path}:{startLine}-{endLine}'
  path: string         // 相对路径，如 'MEMORY.md'
  source: string       // V1 固定 'memory'
  content: string      // 块文本
  startLine: number    // 1-based
  endLine: number      // 1-based，inclusive
  embedding?: number[] // 向量（降级模式下为 undefined）
  model?: string       // 生成向量的模型标识
  updatedAt: number
}
```

### 4.2 MemorySearchResult

```
MemorySearchResult {
  path, content, startLine, endLine
  score: number        // 0-1，越高越相关
  matchType: 'vector' | 'keyword' | 'hybrid'
}
```

### 4.3 MemoryStore 接口

```
MemoryStore {
  upsertChunks(chunks)       // 批量 insert/update
  deleteByPath(path)
  searchByVector(embedding, topK, model)  // 向量相似度
  searchByKeyword(query, topK)            // BM25
  getFile(path) / upsertFile / deleteFile // 文件变更追踪
  getMeta(key) / setMeta(key, value)      // 元数据（如嵌入模型版本）
  close()
}
```

---

## 5. 初始化流程

```
MemoryManager.create(config):

  1. createEmbeddingProvider(config.embedding)
     → 成功：LocalEmbeddingProvider（Xenova 本地模型）
     → 失败：null（降级，纯关键词搜索）

  2. SqliteMemoryStore(dbPath)
     → 创建 .agent/ 目录（如不存在）

  3. new MemoryIndexer(store, embeddingProvider)
     new MemorySearcher(store, embeddingProvider)
     new RecallTracker('.agent/memory/.recalls')

  4. indexer.indexWorkspace(workspaceDir)
     → 扫描 .agent/*.md 文件
     → 增量更新（按文件 hash + mtime 判断是否变化）
     → 切块（1600 chars / 320 overlap）→ 嵌入 → upsertChunks
```

---

## 6. 搜索流程（混合搜索）

```
MemorySearcher.search(query, options):

  vectorResults  = store.searchByVector(embed(query), topK*2, model)
  keywordResults = store.searchByKeyword(query, topK*2)

  混合评分 = vectorWeight × vectorScore + textWeight × keywordScore
  // 默认 0.7 × vector + 0.3 × keyword

  去重 + 按分数排序 → 过滤 < minScore → 取前 maxResults 条
```

嵌入提供者为 null 时跳过向量搜索，退化为纯关键词搜索（matchType='keyword'）。

---

## 7. Memory 工具

`createMemoryTools(manager)` 创建三个 Tool 实例：

| 工具 | 功能 | 关键输入 |
|---|---|---|
| `memory_search` | 混合搜索记忆 | `query`, `maxResults?`, `minScore?` |
| `memory_get` | 读取指定文件内容 | `path` |
| `memory_write` | 写入/更新记忆文件 | `path`, `content` |

`memory_write` 写入后触发 `indexer.indexFile(path)` 立即重新索引，让本次写入在下一次搜索中即时可见。

---

## 8. 关键设计决策

| 决策 | 说明 |
|---|---|
| 异步工厂方法 `create()` | 初始化涉及 I/O（模型加载、DB 创建、首次索引），不适合构造函数 |
| MemoryStore 接口抽象 | V1 用 SQLite，接口隔离后续可替换为其他存储（如远程向量数据库） |
| 降级为纯关键词搜索 | 嵌入模型加载失败不阻塞整体初始化，保留基础搜索能力 |
| RecallTracker 异步写入 | 搜索历史记录不在搜索结果路径上，异步落盘不影响搜索延迟 |
| 增量索引 | 按 hash + mtime 判断文件是否变化，避免每次启动全量重索引 |
