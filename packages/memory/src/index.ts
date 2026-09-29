// Public type surface.
export type { ChunkingOptions, ContentChunk, ExtractedDocument, StructureHint } from './chunking';
export type {
  ConsolidationChunkedTaskOptions,
  ConsolidationState,
  CreateConsolidationOptions,
} from './consolidation';
export type { CreateWeftMemoryRecordStorageOptions } from './create-weft-memory-record-storage';
export type { DualNamespaceMemoryOptions } from './dual-namespace-memory';
export type { CachedEmbedder, EmbeddingCacheOptions } from './embedding-cache';
export type { RunCaptureHookOptions, StepResultLike } from './experiential';
export type {
  FileSynchronizer,
  FileSynchronizerOptions,
  SynchronizeResult,
} from './file-synchronizer';
export type {
  AttenuateMemoryAuthorityRequest,
  CreateMemoryAuthorityInput,
  MemoryAuthority,
  MemoryAuthorityErrorCode,
  MemoryAuthorityFromToolContextOptions,
  MemoryCapability,
  MemoryDelegationLink,
  MemoryOperation,
  MemoryPrincipal,
  MemoryPrincipalKind,
  MemoryProjection,
} from './governance/authority';
export type { MemoryEvidence } from './governance/evidence';
export type {
  CreateGovernedMemoryOptions,
  GovernedListOptions,
  GovernedMemory,
  GovernedSearchHit,
  GovernedSearchOptions,
  GovernedWriteOptions,
  MemoryDeletionPropagation,
  MemoryDeletionPropagationRequest,
  MemoryDeletionPropagationResult,
  MemoryDeletionPropagator,
  MemoryDeletionResult,
  MemoryEvidenceBundle,
  MemoryExportResult,
  MemoryForgetMode,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryGovernanceNotification,
  MemoryLegalHoldResult,
  MemoryOperationResult,
  MemoryOperationStatus,
  MemoryRecordLocator,
  MemoryRetentionCandidate,
  MemoryRetentionSweep,
  MemoryWriteReceipt,
  MemoryWriteRejection,
  RecallForModelOptions,
} from './governance/governed-memory-types';
export type {
  CreateGovernedMemoryToolsOptions,
  GovernedMemoryToolAuthorityInput,
} from './governance/governed-tools';
export type {
  CreateMemoryGovernanceLedgerOptions,
  MemoryGovernanceLedger,
} from './governance/ledger';
export type {
  AsynchronousDeletionTarget,
  MemoryDeletionPlan,
  MemoryDeletionReceipt,
  MemoryDeletionTarget,
  MemoryDeletionTargetReceipt,
  MemoryDeletionTargetStatus,
  MemoryExportManifest,
  MemoryGovernanceEvent,
  MemoryLineageLink,
  MemoryPendingDerivation,
  MemoryProtectedDiagnostic,
  SynchronousDeletionTarget,
} from './governance/ledger-types';
export type {
  CreateMemoryGovernancePolicyInput,
  MemoryAdmissionPolicy,
  MemoryClass,
  MemoryGovernancePolicy,
  MemoryRecallPolicy,
  MemoryRetentionPolicy,
  MemoryRetentionRule,
  MemorySourceKind,
  MemoryTenantPolicyOverride,
  MemoryTrust,
  ResolvedTenantPolicy,
} from './governance/policy';
export type {
  MemoryAccessDecision,
  MemoryDenialReason,
  MemoryRecordState,
  MemoryRedaction,
  MemoryResourceDescriptor,
  MemoryVisibility,
} from './governance/predicate';
export type {
  DerivedRecordKind,
  GovernedMemoryRecord,
  LegalHoldState,
  MemoryAttribution,
  MemoryRecordLineage,
  MemoryRecordSourceReference,
  RecordGovernance,
} from './governance/record-governance';
export type { MemoryGuardrailOptions, ScannedMemoryContent } from './guardrail';
export type { MemoryHookOptions } from './hooks';
export type {
  HybridSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  VectorSearchResult,
} from './hybrid-search';
export type { CreateHyDEGeneratorOptions, HyDEOptions, HypotheticalAnswerGenerator } from './hyde';
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
export type { ChunkerFunction, IngestOptions, IngestResult } from './ingest';
export type { MaximalMarginalRelevanceOptions } from './maximal-marginal-relevance';
export type { CreateReflectionHookOptions } from './reflection';
export type { GetMemoryStatusOptions, MemoryStatus } from './status';
export type { TemporalDecayOptions } from './temporal-decay';
export type { TemporalValidityMetadata } from './temporal-validity';
export type { InMemoryMemoryRecordStorageOptions } from './test/index';
export type { BM25Options } from './text-search';
export type { TextSearchProvider } from './text-search-provider';
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
  MemoryRecordReference,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryRecordUpdateOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryVectorSearchResult,
  NamespaceIsolationOptions,
  OnConflictHandler,
} from './types';

// Public runtime surface.
export { chunkMarkdown, chunkText } from './chunking';
export { createConsolidationTask } from './consolidation';
export { createMemory } from './create-memory';
export { createWeftMemoryRecordStorage } from './create-weft-memory-record-storage';
// The default key prefix is public for custom record storage.
export { DEFAULT_MEMORY_KEY_PREFIX } from './create-weft-memory-record-storage';
export { createDualNamespaceMemory } from './dual-namespace-memory';
export { withEmbeddingCache } from './embedding-cache';
export { createRunCaptureHook, summarizeRun } from './experiential';
export { createFileSynchronizer } from './file-synchronizer';
export {
  assertMemoryAuthority,
  attenuateMemoryAuthority,
  createMemoryAuthority,
  delegationChainIncludes,
  hasMemoryCapability,
  holdsGovernanceAuthority,
  holdsServiceAuthority,
  memoryAuthorityFromToolRequestContext,
  requestPrincipal,
} from './governance/authority';
// Capability, operation, principal-kind, and projection vocabularies are public constants.
export {
  MEMORY_ADMINISTRATIVE_CAPABILITIES,
  MEMORY_CAPABILITIES,
  MEMORY_OPERATIONS,
  MEMORY_PRINCIPAL_KINDS,
  MEMORY_PROJECTIONS,
} from './governance/authority';
// Authority errors are public constructors.
export { MemoryAuthorityError } from './governance/authority';
export { MEMORY_EVIDENCE_PREAMBLE, renderMemoryEvidence } from './governance/evidence';
export { createGovernedMemory } from './governance/governed-memory';
export { createGovernedMemoryTools } from './governance/governed-tools';
export { createMemoryGovernanceLedger } from './governance/ledger';
// The default governance key prefix is public for custom ledger storage.
export { DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX } from './governance/ledger';
export {
  ASYNCHRONOUS_DELETION_TARGETS,
  MEMORY_DELETION_TARGETS,
  SYNCHRONOUS_DELETION_TARGETS,
} from './governance/ledger-types';
export { createMemoryPoisoningDetector } from './governance/poisoning-detector';
export { createMemoryGovernancePolicy, resolveTenantPolicy } from './governance/policy';
// Policy vocabularies and retention defaults are public constants.
export {
  DEFAULT_DELETION_BOUND_MILLISECONDS,
  DEFAULT_EPISODIC_RETENTION_MILLISECONDS,
  DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS,
  MEMORY_CLASSES,
  MEMORY_SOURCE_KINDS,
  MEMORY_TRUST_LEVELS,
  MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS,
} from './governance/policy';
// Policy errors are public constructors.
export { MemoryGovernancePolicyError } from './governance/policy';
export { decideMemoryAccess } from './governance/predicate';
export { collectionNamespace } from './governance/record-governance';
// Derived record kinds and the governance metadata key are public constants.
export {
  DERIVED_RECORD_KINDS,
  MEMORY_GOVERNANCE_METADATA_KEY,
} from './governance/record-governance';
export { provenanceForMemoryEntry, scanMemoryContent } from './guardrail';
export { createMemoryHooks } from './hooks';
export { chunkHtml } from './html-chunking';
export { mergeHybridResults } from './hybrid-search';
export { createHyDEGenerator, withHyDE } from './hyde';
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
export { CHUNK_INDEX_KEY, ingest } from './ingest';
// The source-document key is public for ingestion metadata.
export { SOURCE_DOCUMENT_KEY } from './ingest';
export { applyMaximalMarginalRelevance } from './maximal-marginal-relevance';
export { MemoryRecordVersionConflictError } from './memory-record-storage';
export { withNamespaceIsolation } from './namespace-isolation';
export { extractKeywords, isStopWord } from './query-expansion';
export { createReflectionHook } from './reflection';
export { getMemoryStatus } from './status';
export { applyTemporalDecay, computeTemporalDecay } from './temporal-decay';
export { filterByValidity, isValidAtTimestamp, stampSupersession } from './temporal-validity';
export { createInMemoryMemoryRecordStorage, createMockEmbedder } from './test/index';
export { computeBM25Scores, tokenize } from './text-search';
export { createMemoryForgetTool, createMemoryRecallTool, createMemoryStoreTool } from './tools';
