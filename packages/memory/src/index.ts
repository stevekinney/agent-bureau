export type { ChunkingOptions, ContentChunk, ExtractedDocument, StructureHint } from './chunking';
export { chunkMarkdown, chunkText } from './chunking';
export type {
  ConsolidationChunkedTaskOptions,
  ConsolidationState,
  CreateConsolidationOptions,
} from './consolidation';
export { createConsolidationTask } from './consolidation';
export { createMemory } from './create-memory';
export type { CreateWeftMemoryRecordStorageOptions } from './create-weft-memory-record-storage';
export {
  createWeftMemoryRecordStorage,
  DEFAULT_MEMORY_KEY_PREFIX,
} from './create-weft-memory-record-storage';
export type { DualNamespaceMemoryOptions } from './dual-namespace-memory';
export { createDualNamespaceMemory } from './dual-namespace-memory';
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
export type { MemoryHookOptions } from './hooks';
export { createMemoryHooks } from './hooks';
export { chunkHtml } from './html-chunking';
export type {
  HybridSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  VectorSearchResult,
} from './hybrid-search';
export { mergeHybridResults } from './hybrid-search';
export type { CreateHyDEGeneratorOptions, HyDEOptions, HypotheticalAnswerGenerator } from './hyde';
export { createHyDEGenerator, withHyDE } from './hyde';
export type { ChunkerFunction, IngestOptions, IngestResult } from './ingest';
export { CHUNK_INDEX_KEY, ingest, SOURCE_DOCUMENT_KEY } from './ingest';
export type { MaximalMarginalRelevanceOptions } from './maximal-marginal-relevance';
export { applyMaximalMarginalRelevance } from './maximal-marginal-relevance';
export { withNamespaceIsolation } from './namespace-isolation';
export { extractKeywords, isStopWord } from './query-expansion';
export type { CreateReflectionHookOptions } from './reflection';
export { createReflectionHook } from './reflection';
export type { GetMemoryStatusOptions, MemoryStatus } from './status';
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
  MemoryListOptions,
  MemoryMetadata,
  MemoryRecord,
  MemoryRecordPutOnceResult,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryVectorSearchResult,
  NamespaceIsolationOptions,
  OnConflictHandler,
} from './types';

// ── Identity ───────────────────────────────────────────────────────
export type {
  AgentIdentity,
  CreateSoulDistillationOptions,
  CreateSoulSeedOptions,
  IdentityProvider,
  PersonaDescriptor,
  SoulBudget,
  SoulDiff,
  SoulDiffEntry,
  SoulDistillationChunkedTaskOptions,
  SoulDistillationState,
  SoulHistoryEntry,
  SoulItem,
} from './identity';
export {
  acceptSoulUpdate,
  createIdentityToolbox,
  createPersonaCreateTool,
  createPersonaDeleteTool,
  createPersonaListTool,
  createPersonaUpdateTool,
  createPersonaViewTool,
  createSoulAcceptTool,
  createSoulDiffTool,
  createSoulDistillationTask,
  createSoulPinTool,
  createSoulRejectTool,
  createSoulSeed,
  createSoulViewTool,
  createStaticIdentityProvider,
  createStorageIdentityProvider,
  getSoulDiff,
  pinSoulItem,
  rejectSoulUpdate,
  resolveIdentity,
  unpinSoulItem,
} from './identity';
