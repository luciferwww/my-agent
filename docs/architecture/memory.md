# Memory

> Status: Current Authority
> Authority: Current implemented Memory behavior
> Verified: 2026-09-16
> Ownership: Memory Store, Markdown indexing, retrieval, recall tracking, Tools, and optional degradation
> Ownership key: memory-index-and-search

---

## 1. Boundary

`src/core/memory/` owns the optional Memory Store abstraction, SQLite implementation, Markdown indexing, vector/keyword retrieval, and recall tracking. `src/builtins/tools/memory/` owns the three concrete Memory Tools and their Runtime Contribution. Runtime owns whether Memory is enabled, publication of the Memory Tool Unit, and aggregate resource Shutdown.

When Runtime cannot create or initialize Memory, startup continues with a recoverable warning and without Memory Tools. Failure to select or probe an embedding provider yields keyword-only retrieval; failures later encountered while embedding/indexing propagate to Runtime's optional-capability degradation boundary.

## 2. Components and storage

```text
MemoryManager
├── SqliteMemoryStore       <agentHome>/memory.sqlite
├── MemoryIndexer           MEMORY.md + direct memory/*.md files
├── MemorySearcher          vector + FTS5 keyword retrieval
├── RecallTracker           <agentHome>/memory-recalls/recall-log.jsonl
└── EmbeddingProvider?      local provider or null
```

`MemoryStore` owns file/chunk metadata, vector lookup, keyword lookup, metadata values, and close. `SqliteMemoryStore` uses WAL mode, a five-second busy timeout, ordinary tables for files/chunks/meta, and a standalone FTS5 table for keyword content. Embeddings are persisted as Float32 BLOBs and vector search computes cosine similarity over chunks produced by the same model ID.

The SQLite and recall paths are implementation conventions, not configurable schema fields.

## 3. Initialization and indexing

`MemoryManager.create()` selects the optional embedding provider, opens SQLite, constructs the Indexer/Searcher/Recall Tracker, and calls `indexAll(agentHome)`.

- `MEMORY.md` at the Agent Home root is indexed when present.
- Only direct Markdown files under `memory/` are included; nested files and other extensions are skipped.
- Missing root/file directories are non-fatal.
- Content SHA-256 identifies unchanged files; unchanged content skips deletion, embedding, chunk writes, and file-metadata updates.
- Changed content is split on line boundaries into approximately 1600-character chunks with approximately 320 characters of line-aligned overlap.
- Chunk IDs encode source, relative path, and inclusive 1-based line range.
- Existing chunks for the path are deleted before replacement chunks and file metadata are written.
- With an embedding provider, all new chunks are embedded in one batch and tagged with its model ID. Without one, chunks remain keyword-searchable.

`writeFile()` creates parent directories, appends with one separating newline or overwrites, reads the resulting content, and immediately reindexes that file. `reindex()` repeats Agent Home discovery and indexing.

## 4. Embeddings and degradation

The default local provider is `Xenova/all-MiniLM-L6-v2` with 384 dimensions. Known model dimensions come from a static map; an unknown local model is loaded and probed once. Probe/load failure at that selection step returns `null`, and unsupported provider type currently also returns `null`.

A `LocalEmbeddingProvider` lazily initializes one shared Transformers feature-extraction pipeline, uses mean pooling with normalization, and returns complete vectors without truncation. The Transformers model cache is external to Memory's SQLite store.

## 5. Search

`MemorySearcher.search()` uses per-call options or implementation defaults:

| Option | Default |
|---|---:|
| maximum results | 6 |
| minimum score | 0.25 |
| vector weight | 0.7 |
| keyword weight | 0.3 |

With embeddings, the query is embedded once. Vector and FTS5 candidates are fetched at twice the requested result count, each score set is min-max normalized, duplicate chunk IDs are merged, dual matches are marked `hybrid`, and results are thresholded, sorted, and truncated. With no embedding provider, vector work is skipped and normalized keyword results are returned. Invalid FTS5 query syntax is contained as an empty keyword result rather than escaping.

Although `MemoryConfig` currently carries a `search` field and Runtime passes resolved search configuration into `MemoryManager.create()`, the manager does not apply that field to `MemorySearcher`; effective defaults are the constants above unless a caller supplies `SearchOptions` to `search()`.

`MemoryManager.search()` asynchronously records the query plus hit paths, line ranges, and scores. Recall logging is fire-and-forget; directory or append failure does not change the returned result.

## 6. Memory Tools

Runtime publishes required builtin Unit `builtin-memory-tools` only when a `MemoryManager` exists.

| Tool | Current behavior |
|---|---|
| `memory_search` | validates a non-empty query, accepts optional `maxResults`/`minScore`, runs retrieval, and formats scored path/line results |
| `memory_get` | reads `MEMORY.md` or any string that starts with `memory/` and ends with `.md`, optionally from a 1-based start line for a requested count; the Manager rejects lexical escape outside Agent Home |
| `memory_write` | appends by default or overwrites; accepts `MEMORY.md` or `memory/YYYY-MM-DD.md`, then immediately reindexes full content |

The Tool predicates are distinct from startup/reindex discovery: the Indexer discovers only `MEMORY.md` and direct Markdown children of `memory/`. Files addressed through a broader `memory_get` path are not thereby added to that discovery set. `MemoryManager` resolves reads and writes against Agent Home and rejects lexical traversal outside that owner boundary; this is containment, not a general permission system.

Tool execution converts read/write failures into failed Tool outcomes. Generic Tool validation, policy, approval, and execution semantics belong to [Tools](tools.md).

## 7. Lifecycle

`MemoryManager.close()` closes SQLite. Runtime owns cleanup after bootstrap failure and normal Shutdown, applies the shared deadline budget, and reports failed or non-converged Memory cleanup. Memory does not own application admission, generation retirement, or Session persistence.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [MemoryManager](../../src/core/memory/MemoryManager.ts), [Memory contracts](../../src/core/memory/types.ts), [MemoryIndexer](../../src/core/memory/internal/MemoryIndexer.ts), [MemorySearcher](../../src/core/memory/internal/MemorySearcher.ts), [SQLite Store](../../src/core/memory/internal/sqlite-store.ts), [RecallTracker](../../src/core/memory/internal/RecallTracker.ts), [LocalEmbeddingProvider](../../src/core/memory/internal/LocalEmbeddingProvider.ts), [Memory Tools](../../src/builtins/tools/memory/memory-tools.ts), [Runtime bootstrap](../../src/runtime/bootstrap.ts), [Memory Tool contribution](../../src/builtins/tools/memory/contribution.ts) |
| Tests | [MemoryManager tests](../../src/core/memory/MemoryManager.test.ts), [MemoryIndexer tests](../../src/core/memory/internal/MemoryIndexer.test.ts), [MemorySearcher tests](../../src/core/memory/internal/MemorySearcher.test.ts), [SQLite Store tests](../../src/core/memory/internal/sqlite-store.test.ts), [RecallTracker tests](../../src/core/memory/internal/RecallTracker.test.ts), [LocalEmbeddingProvider tests](../../src/core/memory/internal/LocalEmbeddingProvider.test.ts), [Runtime degradation/cleanup tests](../../src/runtime/RuntimeApp.test.ts), [Memory Tool contribution tests](../../src/builtins/tools/memory/contribution.test.ts) |
| Controlling authority | [ADR-007](../decisions/adr-007-builtin-capability-source-ownership.md), [Runtime Composition Specification](../specifications/runtime-composition.md), [Configuration Specification](../specifications/configuration.md) |
