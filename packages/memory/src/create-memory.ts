import type { VectorData } from 'vector-frankl';

import type { HybridSearchCandidate, VectorSearchResult } from './hybrid-search';
import { mergeHybridResults } from './hybrid-search';
import { applyMaximalMarginalRelevance, cosineSimilarity } from './maximal-marginal-relevance';
import { applyTemporalDecay } from './temporal-decay';
import { computeBM25Scores } from './text-search';
import type {
  CreateMemoryOptions,
  Memory,
  MemoryEntry,
  MemoryMetadata,
  MemorySearchOptions,
  MemorySearchResult,
} from './types';

const DEFAULT_DEDUPLICATION_THRESHOLD = 0.95;
const DEFAULT_NAMESPACE = 'default';
const METADATA_CONTENT_KEY = '__memory_content';
const METADATA_NAMESPACE_KEY = '__memory_namespace';

function generateId(): string {
  return crypto.randomUUID();
}

function computeMagnitude(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i]! * vector[i]!;
  }
  return Math.sqrt(sum);
}

function parseMemoryMetadata(
  raw: Record<string, unknown>,
  fallbackNamespace: string,
): MemoryMetadata {
  return {
    namespace: (raw[METADATA_NAMESPACE_KEY] as string) ?? fallbackNamespace,
    source: (raw['source'] as MemoryMetadata['source']) ?? 'manual',
    conversationId: raw['conversationId'] as string | undefined,
    agentId: raw['agentId'] as string | undefined,
    importance: raw['importance'] as number | undefined,
    evergreen: raw['evergreen'] as boolean | undefined,
    tags: raw['tags'] as string[] | undefined,
  };
}

function buildStorageMetadata(
  content: string,
  namespace: string,
  metadata: Partial<MemoryMetadata>,
): Record<string, unknown> {
  return {
    ...metadata,
    [METADATA_CONTENT_KEY]: content,
    [METADATA_NAMESPACE_KEY]: namespace,
  };
}

/**
 * Creates a Memory instance backed by a vector-frankl StorageAdapter.
 *
 * The returned object satisfies the Memory interface and provides:
 * - remember() with automatic deduplication
 * - recall() with hybrid (vector + BM25) search, temporal decay, and MMR diversity
 * - forget(), forgetAll(), count() for lifecycle management
 */
export function createMemory(options: CreateMemoryOptions): Memory {
  const {
    embedder,
    storage,
    namespace: defaultNamespace = DEFAULT_NAMESPACE,
    defaultSearchOptions,
    deduplicationThreshold = DEFAULT_DEDUPLICATION_THRESHOLD,
  } = options;

  async function embed(text: string): Promise<number[]> {
    const vectors = await embedder([text]);
    return vectors[0]!;
  }

  async function getAllInNamespace(namespace: string): Promise<VectorData[]> {
    const all = await storage.getAll();
    return all.filter((entry) => entry.metadata?.[METADATA_NAMESPACE_KEY] === namespace);
  }

  async function findDuplicate(
    vector: number[],
    namespace: string,
  ): Promise<VectorData | undefined> {
    const entries = await getAllInNamespace(namespace);
    for (const entry of entries) {
      const existingVector = Array.from(entry.vector);
      const similarity = cosineSimilarity(vector, existingVector);
      if (similarity >= deduplicationThreshold) {
        return entry;
      }
    }
    return undefined;
  }

  async function vectorSearch(
    queryVector: number[],
    namespace: string,
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const entries = await getAllInNamespace(namespace);
    const scored: VectorSearchResult[] = [];

    for (const entry of entries) {
      const entryVector = Array.from(entry.vector);
      const score = cosineSimilarity(queryVector, entryVector);
      scored.push({ id: entry.id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  const memory: Memory = {
    async remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry> {
      const namespace = metadata?.namespace ?? defaultNamespace;
      const vector = await embed(content);
      const float32Vector = new Float32Array(vector);

      // Check for deduplication
      const duplicate = await findDuplicate(vector, namespace);

      if (duplicate) {
        const now = Date.now();
        const updatedMetadata = buildStorageMetadata(content, namespace, {
          source: 'manual',
          ...metadata,
        });

        await storage.updateMetadata(duplicate.id, updatedMetadata, {
          merge: false,
          updateTimestamp: true,
        });
        await storage.updateVector(duplicate.id, float32Vector, {
          updateMagnitude: true,
          updateTimestamp: true,
        });

        return {
          id: duplicate.id,
          content,
          vector,
          metadata: {
            namespace,
            source: 'manual',
            ...metadata,
          } as MemoryMetadata,
          createdAt: duplicate.timestamp,
          updatedAt: now,
        };
      }

      const id = generateId();
      const now = Date.now();
      const storageMetadata = buildStorageMetadata(content, namespace, {
        source: 'manual',
        ...metadata,
      });

      const vectorData: VectorData = {
        id,
        vector: float32Vector,
        metadata: storageMetadata,
        magnitude: computeMagnitude(float32Vector),
        timestamp: now,
      };

      await storage.put(vectorData);

      return {
        id,
        content,
        vector,
        metadata: {
          namespace,
          source: 'manual',
          ...metadata,
        } as MemoryMetadata,
        createdAt: now,
        updatedAt: now,
      };
    },

    async recall(
      query: string,
      searchOptions?: MemorySearchOptions,
    ): Promise<MemorySearchResult[]> {
      const mergedOptions = { ...defaultSearchOptions, ...searchOptions };
      const namespace = mergedOptions.namespace ?? defaultNamespace;
      const limit = mergedOptions.limit ?? 10;
      const threshold = mergedOptions.threshold ?? 0;
      const vectorWeight = mergedOptions.vectorWeight ?? 0.7;
      const textWeight = mergedOptions.textWeight ?? 0.3;

      const queryVector = await embed(query);
      const namespacedEntries = await getAllInNamespace(namespace);

      if (namespacedEntries.length === 0) return [];

      // Build candidates for hybrid search
      const candidates: HybridSearchCandidate[] = namespacedEntries.map((entry) => ({
        id: entry.id,
        content: (entry.metadata?.[METADATA_CONTENT_KEY] as string) ?? '',
        metadata: entry.metadata ?? {},
        createdAt: entry.timestamp,
      }));

      // Vector similarity search
      const candidateMultiplier = 3;
      const vectorResultLimit = limit * candidateMultiplier;
      const vectorResults = await vectorSearch(queryVector, namespace, vectorResultLimit);

      // BM25 text search
      const documents = candidates.map((candidate) => candidate.content);
      const textScores = computeBM25Scores(query, documents);

      // Merge hybrid results
      const hybridResults = mergeHybridResults(vectorResults, textScores, candidates, {
        vectorWeight,
        textWeight,
        limit: limit * candidateMultiplier,
        threshold,
      });

      // Convert to MemorySearchResult with vectors for MMR
      let results: (MemorySearchResult & { vector?: number[] })[] = hybridResults.map((result) => {
        const matchedEntry = namespacedEntries.find((entry) => entry.id === result.id);
        const rawMetadata = result.metadata;

        return {
          id: result.id,
          content: result.content,
          score: result.combinedScore,
          metadata: parseMemoryMetadata(rawMetadata, namespace),
          createdAt: result.createdAt,
          vector: matchedEntry ? Array.from(matchedEntry.vector) : undefined,
        };
      });

      // Apply temporal decay if configured
      if (mergedOptions.temporalDecay) {
        results = applyTemporalDecay(results, {
          halfLifeMilliseconds: mergedOptions.temporalDecay.halfLifeMilliseconds,
          evergreenExempt: mergedOptions.temporalDecay.evergreenExempt ?? true,
        });
      }

      // Apply MMR for diversity if configured
      if (mergedOptions.diversify) {
        results = applyMaximalMarginalRelevance(results, limit, {
          lambda: mergedOptions.diversify.lambda,
        });
      }

      // Final limit and strip vectors from output
      return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
    },

    async forget(id: string): Promise<void> {
      await storage.delete(id);
    },

    async forgetAll(namespace?: string): Promise<void> {
      const targetNamespace = namespace ?? defaultNamespace;
      const entries = await getAllInNamespace(targetNamespace);
      const ids = entries.map((entry) => entry.id);
      if (ids.length > 0) {
        await storage.deleteMany(ids);
      }
    },

    async count(namespace?: string): Promise<number> {
      const targetNamespace = namespace ?? defaultNamespace;
      const entries = await getAllInNamespace(targetNamespace);
      return entries.length;
    },

    async init(): Promise<void> {
      await storage.init();
    },

    async close(): Promise<void> {
      await storage.close();
    },
  };

  return memory;
}
