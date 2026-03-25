/**
 * Vector Database for IndexedDB
 *
 * A high-performance vector database that runs entirely in the browser,
 * built on top of IndexedDB for persistent storage.
 *
 * Optional subsystems available via deep imports:
 *   vector-frankl/gpu         — GPU acceleration
 *   vector-frankl/workers     — Web Worker pool
 *   vector-frankl/debug       — Debug/profiling tools
 *   vector-frankl/benchmarks  — Performance benchmarks
 *   vector-frankl/compression — Compression internals
 */

// Main API (with namespace support)
export type { VectorFranklOptions } from './api/vector-frankl.ts';
export { VectorFrankl } from './api/vector-frankl.ts';

// Simple API (without namespace support)
export { VectorDB } from './api/database.ts';

// Namespace management
export { AdapterNamespaceRegistry } from './namespaces/adapter-registry.ts';
export { NamespaceManager } from './namespaces/manager.ts';
export { VectorNamespace } from './namespaces/namespace.ts';
export { NamespaceRegistry } from './namespaces/registry.ts';

// Core types
export type {
  AndFilter,
  // Batch operations
  BatchOptions,
  BatchProgress,
  CompressionStrategy,
  // Database types
  DatabaseConfig,
  DistanceMetric,
  FilterOperator,
  FilterValue,
  HNSWParameters,
  IndexConfig,
  // Index types
  IndexStrategy,
  KDTreeParameters,
  MetadataFilter,
  // Namespace types
  NamespaceConfig,
  NamespaceInfo,
  NamespaceStats,
  NotFilter,
  OrFilter,
  // Search types
  SearchOptions,
  SearchResult,
  SimpleFilter,
  // Storage types
  StorageAdapter,
  StorageAdapterFactory,
  StorageEstimate,
  VectorData,
  VectorFormat,
} from './core/types.ts';

// Errors
export {
  BatchOperationError,
  BrowserSupportError,
  DatabaseInitializationError,
  DimensionMismatchError,
  IndexError,
  InvalidFormatError,
  isVectorDatabaseError,
  NamespaceExistsError,
  NamespaceNotFoundError,
  QuotaExceededError,
  TransactionError,
  VectorDatabaseError,
  VectorNotFoundError,
} from './core/errors.ts';

// Vector utilities
export { VectorFormatHandler } from './vectors/formats.ts';
export { VectorOperations } from './vectors/operations.ts';

// Search utilities
export {
  createDistanceCalculator,
  DistanceCalculator,
  type DistanceMetricImplementation,
  DistanceMetrics,
  listAvailableMetrics,
  registerCustomMetric,
} from './search/distance-metrics.ts';
export { HNSWIndex } from './search/hnsw-index.ts';
export { IndexCache, IndexPersistence } from './search/index-persistence.ts';
export {
  MetadataFilterCompiler,
  metadataQuery,
  MetadataRangeQuery,
} from './search/metadata-filter.ts';
export { SearchEngine } from './search/search-engine.ts';

// Storage adapters (universally usable)
export { IndexedDatabaseStorageAdapter } from './storage/adapters/indexed-database-adapter.ts';
export { MemoryStorageAdapter } from './storage/adapters/memory-adapter.ts';
export { OPFSStorageAdapter } from './storage/adapters/opfs-adapter.ts';
export { SQLiteStorageAdapter } from './storage/adapters/sqlite-adapter.ts';

// Storage management utilities
export {
  type EvictionConfig,
  EvictionManager,
  type EvictionResult,
  HybridEvictionPolicy,
  LFUEvictionPolicy,
  LRUEvictionPolicy,
  ScoreBasedEvictionPolicy,
  TTLEvictionPolicy,
} from './storage/eviction-policy.ts';
export {
  type QuotaEstimate,
  type QuotaWarning,
  type StorageBreakdown,
  StorageQuotaMonitor,
} from './storage/quota-monitor.ts';

// Version — hardcoded to avoid importing package.json
export const VERSION = '0.0.1';
