export type { ChunkingOptions, ContentChunk } from './chunking';
export { chunkMarkdown } from './chunking';
export { createMemory, METADATA_NAMESPACE_KEY } from './create-memory';
export type { CreateSQLiteMemoryOptions } from './create-sqlite-memory';
export { createSQLiteMemory, SQLiteStorageAdapter } from './create-sqlite-memory';
export type { CachedEmbedder, EmbeddingCacheOptions } from './embedding-cache';
export { withEmbeddingCache } from './embedding-cache';
export type { RunCaptureHookOptions, StepResultLike } from './experiential';
export { createRunCaptureHook, summarizeRun } from './experiential';
export type {
  FileSynchronizer,
  FileSynchronizerOptions,
  SynchronizeResult,
} from './file-synchronizer';
export { createFileSynchronizer } from './file-synchronizer';
export type { Fts5TextSearchProviderOptions } from './fts5-text-search-provider';
export { createFts5TextSearchProvider } from './fts5-text-search-provider';
export type { MemoryHookOptions } from './hooks';
export { createMemoryHooks } from './hooks';
export type {
  HybridSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  VectorSearchResult,
} from './hybrid-search';
export { mergeHybridResults } from './hybrid-search';
export type { CreateHyDEGeneratorOptions, HyDEOptions, HypotheticalAnswerGenerator } from './hyde';
export { createHyDEGenerator, withHyDE } from './hyde';
export type { IngestOptions, IngestResult } from './ingest';
export { CHUNK_INDEX_KEY, ingest, SOURCE_DOCUMENT_KEY } from './ingest';
export type { MaximalMarginalRelevanceOptions } from './maximal-marginal-relevance';
export { applyMaximalMarginalRelevance, cosineSimilarity } from './maximal-marginal-relevance';
export { withNamespaceIsolation } from './namespace-isolation';
export { extractKeywords, isStopWord } from './query-expansion';
export type { CreateReflectionHookOptions } from './reflection';
export { createReflectionHook } from './reflection';
export type { MemoryStatus } from './status';
export { getMemoryStatus } from './status';
export type { TemporalDecayOptions } from './temporal-decay';
export { applyTemporalDecay, computeTemporalDecay } from './temporal-decay';
export type { BM25Options } from './text-search';
export { computeBM25Scores, tokenize } from './text-search';
export type { TextSearchProvider } from './text-search-provider';
export { createMemoryForgetTool, createMemoryRecallTool, createMemoryStoreTool } from './tools';
export type {
  CreateMemoryOptions,
  Embedder,
  EmbeddingVector,
  Memory,
  MemoryEntry,
  MemoryMetadata,
  MemorySearchOptions,
  MemorySearchResult,
  NamespaceIsolationOptions,
  OnConflictHandler,
} from './types';
