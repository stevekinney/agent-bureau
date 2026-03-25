/**
 * Web Worker pool utilities
 * Import via: vector-frankl/workers
 */
export {
  getSharedMemoryManager,
  type MemoryBlock,
  type SharedMemoryConfig,
  type SharedMemoryLayout,
  SharedMemoryManager,
  type SharedMemoryStats,
} from './workers/shared-memory.ts';
export {
  type PoolConfig,
  WorkerPool,
  type WorkerResponse,
  type WorkerTask,
} from './workers/worker-pool.ts';
