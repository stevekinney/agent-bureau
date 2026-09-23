export { chunkMarkdown, chunkText } from './chunking';
export type { ChunkingOptions, ContentChunk, ExtractedDocument, StructureHint } from './chunking';
export { createConsolidationTask } from './consolidation';
export type {
  ConsolidationChunkedTaskOptions,
  ConsolidationState,
  CreateConsolidationOptions,
} from './consolidation';
export { createMemory } from './create-memory';
export {
  DEFAULT_MEMORY_KEY_PREFIX,
  createWeftMemoryRecordStorage,
} from './create-weft-memory-record-storage';
export type { CreateWeftMemoryRecordStorageOptions } from './create-weft-memory-record-storage';
export { createDualNamespaceMemory } from './dual-namespace-memory';
export type { DualNamespaceMemoryOptions } from './dual-namespace-memory';
export { withEmbeddingCache } from './embedding-cache';
export type { CachedEmbedder, EmbeddingCacheOptions } from './embedding-cache';
export { createRunCaptureHook, summarizeRun } from './experiential';
export type { RunCaptureHookOptions, StepResultLike } from './experiential';
export { createFileSynchronizer } from './file-synchronizer';
export type {
  FileSynchronizer,
  FileSynchronizerOptions,
  SynchronizeResult,
} from './file-synchronizer';
export { provenanceForMemoryEntry, scanMemoryContent } from './guardrail';
export type { MemoryGuardrailOptions, ScannedMemoryContent } from './guardrail';
export { createMemoryHooks } from './hooks';
export type { MemoryHookOptions } from './hooks';
export { chunkHtml } from './html-chunking';
export { mergeHybridResults } from './hybrid-search';
export type {
  HybridSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  VectorSearchResult,
} from './hybrid-search';
export { createHyDEGenerator, withHyDE } from './hyde';
export type { CreateHyDEGeneratorOptions, HyDEOptions, HypotheticalAnswerGenerator } from './hyde';
export { CHUNK_INDEX_KEY, SOURCE_DOCUMENT_KEY, ingest } from './ingest';
export type { ChunkerFunction, IngestOptions, IngestResult } from './ingest';
export { applyMaximalMarginalRelevance } from './maximal-marginal-relevance';
export type { MaximalMarginalRelevanceOptions } from './maximal-marginal-relevance';
export { withNamespaceIsolation } from './namespace-isolation';
export { extractKeywords, isStopWord } from './query-expansion';
export { createReflectionHook } from './reflection';
export type { CreateReflectionHookOptions } from './reflection';
export { getMemoryStatus } from './status';
export type { GetMemoryStatusOptions, MemoryStatus } from './status';
export { applyTemporalDecay, computeTemporalDecay } from './temporal-decay';
export type { TemporalDecayOptions } from './temporal-decay';
export { filterByValidity, isValidAtTimestamp, stampSupersession } from './temporal-validity';
export type { TemporalValidityMetadata } from './temporal-validity';
export { createInMemoryMemoryRecordStorage, createMockEmbedder } from './test/index';
export type { InMemoryMemoryRecordStorageOptions } from './test/index';
export { computeBM25Scores, tokenize } from './text-search';
export type { BM25Options } from './text-search';
export type { TextSearchProvider } from './text-search-provider';
export { createMemoryForgetTool, createMemoryRecallTool, createMemoryStoreTool } from './tools';
export type { CreateMemoryRecallToolOptions } from './tools';
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
