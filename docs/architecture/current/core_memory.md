# Core Memory Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: Memory Store, indexing, search, tools, and optional degradation
> Ownership key: memory-index-and-search

## 1. Boundary

`src/core/memory/` owns the optional Memory capability: Store abstraction, SQLite implementation, Markdown indexing, hybrid retrieval, recall tracking, and three Memory Tools. Runtime owns whether Memory is enabled, publication of its Tool Unit, and aggregate resource Shutdown.

If Runtime cannot create Memory, application startup continues without Memory Tools. Inside Memory creation, inability to create an embedding provider yields keyword-only retrieval rather than disabling the SQLite capability.

## 2. Components and storage

```text
MemoryManager
├── SqliteMemoryStore       .agent/memory.sqlite
├── MemoryIndexer           MEMORY.md + memory/*.md
├── MemorySearcher          vector + keyword merge
├── RecallTracker           .agent/memory/.recalls/
└── EmbeddingProvider?      local provider or null
```

`MemoryStore` owns chunk/file metadata, vector and keyword queries, and close. The default SQLite path and recall directory are implementation conventions, not configurable schema fields.

## 3. Initialization and incremental indexing

`MemoryManager.create()` creates the optional embedding provider, opens SQLite, constructs the Indexer/Searcher/Recall Tracker, and calls `indexAll(workspaceDir)`.

- `MEMORY.md` at workspace root is indexed when present.
- Direct Markdown files under `memory/` are indexed.
- Content SHA-256 identifies unchanged files; unchanged content is skipped.
- Changed content is chunked using current Config, optionally embedded, and upserted.
- Missing files are non-fatal; Store or indexing failure propagates to Runtime's optional-capability degradation boundary.

## 4. Search

With an embedding provider, `MemorySearcher` obtains vector and BM25 candidates, normalizes/merges scores with configured weights, deduplicates chunks, filters by minimum score, and returns the requested maximum. With no embedding provider, vector work is skipped and results are keyword-only.

`MemoryManager.search()` records query and hit locations asynchronously through `RecallTracker`; recall-log failure does not alter the returned search result.

## 5. Memory Tools

| Tool | Current behavior |
|---|---|
| `memory_search` | runs governed retrieval with optional result/score overrides |
| `memory_get` | reads a Memory file or requested line range |
| `memory_write` | appends/overwrites a file and immediately reindexes its content |

The Tools are contributed only when a `MemoryManager` exists. Their generic Tool contract, validation, policy and approval behavior belong to [Core Tools](./core_tools.md).

## 6. Close

`MemoryManager.close()` closes the Store. Runtime owns when this occurs and reports failure/deadline residuals in the aggregate Shutdown report; Memory does not own application admission or generation retirement.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [MemoryManager.ts](../../../src/core/memory/MemoryManager.ts), [types.ts](../../../src/core/memory/types.ts), [MemoryIndexer.ts](../../../src/core/memory/internal/MemoryIndexer.ts), [MemorySearcher.ts](../../../src/core/memory/internal/MemorySearcher.ts), [sqlite-store.ts](../../../src/core/memory/internal/sqlite-store.ts), [RecallTracker.ts](../../../src/core/memory/internal/RecallTracker.ts), [memory-tools.ts](../../../src/core/memory/memory-tools.ts) |
| Tests | [MemoryManager.test.ts](../../../src/core/memory/MemoryManager.test.ts), [MemoryIndexer.test.ts](../../../src/core/memory/internal/MemoryIndexer.test.ts), [MemorySearcher.test.ts](../../../src/core/memory/internal/MemorySearcher.test.ts), [sqlite-store.test.ts](../../../src/core/memory/internal/sqlite-store.test.ts), [RecallTracker.test.ts](../../../src/core/memory/internal/RecallTracker.test.ts), [LocalEmbeddingProvider.test.ts](../../../src/core/memory/internal/LocalEmbeddingProvider.test.ts) |
| Controlling authority | [Runtime Composition Module Spec](../runtime-composition-module-spec.md), [Platform Config Restructure Spec](../platform-config-restructure-spec.md), [Target Architecture](../target-architecture.md) |
