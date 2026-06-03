import { VectorNotFoundError } from '@/core/errors.ts';
import type { BatchOptions, BatchProgress, StorageAdapter, VectorData } from '@/core/types.ts';

import { calculateMagnitude } from './serialization.ts';

interface MemoryStorageAdapterOptions {
  cloneOnRead?: boolean;
  cloneOnWrite?: boolean;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, VectorData>();
  private readonly cloneOnRead: boolean;
  private readonly cloneOnWrite: boolean;

  static isAvailable(): boolean {
    return true;
  }

  constructor(options: MemoryStorageAdapterOptions = {}) {
    this.cloneOnRead = options.cloneOnRead ?? true;
    this.cloneOnWrite = options.cloneOnWrite ?? true;
  }

  private clone(vector: VectorData): VectorData {
    return structuredClone(vector);
  }

  /**
   * Directly insert a vector without modifying timestamps.
   * Useful for testing scenarios that need precise control over access metadata.
   */
  seed(vector: VectorData): void {
    const stored = this.cloneOnWrite ? this.clone(vector) : vector;
    this.store.set(stored.id, stored);
  }

  // Lifecycle

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async destroy(): Promise<void> {
    this.store.clear();
  }

  // Single-item CRUD

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async put(vector: VectorData): Promise<void> {
    const stored = this.cloneOnWrite ? this.clone(vector) : vector;

    if (!stored.timestamp) {
      stored.timestamp = Date.now();
    }
    stored.lastAccessed = Date.now();

    this.store.set(stored.id, stored);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async get(id: string): Promise<VectorData> {
    const entry = this.store.get(id);

    if (!entry) {
      throw new VectorNotFoundError(id);
    }

    entry.lastAccessed = Date.now();
    entry.accessCount = (entry.accessCount ?? 0) + 1;

    return this.cloneOnRead ? this.clone(entry) : entry;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  // Multi-item reads

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async getMany(ids: string[]): Promise<VectorData[]> {
    const results: VectorData[] = [];
    const now = Date.now();

    for (const id of ids) {
      const entry = this.store.get(id);
      if (entry) {
        entry.lastAccessed = now;
        entry.accessCount = (entry.accessCount ?? 0) + 1;
        results.push(this.cloneOnRead ? this.clone(entry) : entry);
      }
    }

    return results;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async getAll(): Promise<VectorData[]> {
    const results: VectorData[] = [];

    for (const entry of this.store.values()) {
      results.push(this.cloneOnRead ? this.clone(entry) : entry);
    }

    return results;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async count(): Promise<number> {
    return this.store.size;
  }

  // Multi-item writes

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async deleteMany(ids: string[]): Promise<number> {
    let deleted = 0;

    for (const id of ids) {
      if (this.store.delete(id)) {
        deleted++;
      }
    }

    return deleted;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async clear(): Promise<void> {
    this.store.clear();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async putBatch(vectors: VectorData[], options?: BatchOptions): Promise<void> {
    const batchSize = options?.batchSize ?? vectors.length;
    const totalBatches = Math.ceil(vectors.length / batchSize);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      if (options?.abortSignal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, vectors.length);

      for (let i = start; i < end; i++) {
        const vector = vectors[i]!;
        const stored = this.cloneOnWrite ? this.clone(vector) : vector;

        if (!stored.timestamp) {
          stored.timestamp = Date.now();
        }
        stored.lastAccessed = Date.now();

        this.store.set(stored.id, stored);
      }

      if (options?.onProgress) {
        const progress: BatchProgress = {
          total: vectors.length,
          completed: end,
          failed: 0,
          percentage: Math.round((end / vectors.length) * 100),
          currentBatch: batchIndex + 1,
          totalBatches,
        };
        options.onProgress(progress);
      }
    }
  }

  // Partial updates (read-modify-write)

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async updateVector(
    id: string,
    vector: Float32Array,
    options?: { updateMagnitude?: boolean; updateTimestamp?: boolean },
  ): Promise<void> {
    const entry = this.store.get(id);

    if (!entry) {
      throw new VectorNotFoundError(id);
    }

    entry.vector = this.cloneOnWrite ? vector.slice() : vector;

    if (options?.updateMagnitude !== false) {
      entry.magnitude = calculateMagnitude(entry.vector);
    }

    if (options?.updateTimestamp !== false) {
      entry.timestamp = Date.now();
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
    options?: { merge?: boolean; updateTimestamp?: boolean },
  ): Promise<void> {
    const entry = this.store.get(id);

    if (!entry) {
      throw new VectorNotFoundError(id);
    }

    const incomingMetadata = this.cloneOnWrite ? structuredClone(metadata) : metadata;

    if (options?.merge !== false && entry.metadata) {
      entry.metadata = { ...entry.metadata, ...incomingMetadata };
    } else {
      entry.metadata = incomingMetadata;
    }

    if (options?.updateTimestamp !== false) {
      entry.timestamp = Date.now();
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- StorageAdapter is async; this backend is synchronous
  async updateBatch(
    updates: Array<{
      id: string;
      vector?: Float32Array;
      metadata?: Record<string, unknown>;
    }>,
    _options?: BatchOptions,
  ): Promise<{
    succeeded: number;
    failed: number;
    errors: Array<{ id: string; error: Error }>;
  }> {
    let succeeded = 0;
    let failed = 0;
    const errors: Array<{ id: string; error: Error }> = [];

    for (const update of updates) {
      try {
        const entry = this.store.get(update.id);

        if (!entry) {
          throw new VectorNotFoundError(update.id);
        }

        if (update.vector) {
          entry.vector = this.cloneOnWrite ? update.vector.slice() : update.vector;
          entry.magnitude = calculateMagnitude(entry.vector);
        }

        if (update.metadata) {
          const incomingMetadata = this.cloneOnWrite
            ? structuredClone(update.metadata)
            : update.metadata;
          entry.metadata = entry.metadata
            ? { ...entry.metadata, ...incomingMetadata }
            : incomingMetadata;
        }

        entry.timestamp = Date.now();
        succeeded++;
      } catch (error) {
        failed++;
        errors.push({
          id: update.id,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    return { succeeded, failed, errors };
  }
}
