export { MemoryManager } from './MemoryManager.js';
export { MemoryIndexer } from './internal/MemoryIndexer.js';
export { MemorySearcher } from './internal/MemorySearcher.js';
export { RecallTracker } from './internal/RecallTracker.js';
export { LocalEmbeddingProvider, createEmbeddingProvider } from './internal/LocalEmbeddingProvider.js';
export { SqliteMemoryStore } from './internal/sqlite-store.js';
export type { MemoryManagerConfig } from './MemoryManager.js';
export type {
  EmbeddingProvider,
  MemoryChunk,
  MemorySearchResult,
  SearchOptions,
  RecallEntry,
  IndexedFileInfo,
  MemoryStore,
} from './types.js';
export {
  DEFAULT_MEMORY_CONFIG,
  MemoryConfigValidationError,
  validateMemoryConfig,
} from './config.js';
export type {
  MemoryConfig,
  EmbeddingConfig,
  ChunkingConfig,
  MemorySearchConfig,
  EmbeddingProviderType,
} from './config.js';
