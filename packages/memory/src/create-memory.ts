import type { VectorData } from 'vector-frankl';

import type { HybridSearchCandidate, VectorSearchResult } from './hybrid-search';
import { mergeHybridResults } from './hybrid-search';
import { SOURCE_DOCUMENT_KEY } from './ingest';
import { applyMaximalMarginalRelevance, cosineSimilarity } from './maximal-marginal-relevance';
import { extractKeywords } from './query-expansion';
import { applyTemporalDecay } from './temporal-decay';
import { computeBM25Scores } from './text-search';
import type {
  CreateMemoryOptions,
  Memory,
  MemoryEntry,
  MemoryListOptions,
  MemoryMetadata,
  MemorySearchOptions,
  MemorySearchResult,
} from './types';

const DEFAULT_DEDUPLICATION_THRESHOLD = 0.95;
const DEFAULT_NAMESPACE = 'default';
const METADATA_CONTENT_KEY = '__memory_content';
export const METADATA_NAMESPACE_KEY = '__memory_namespace';

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
  // Preserve arbitrary extension keys (like __sourceDocument, __chunkIndex)
  // while extracting known fields with proper types.
  const { [METADATA_CONTENT_KEY]: _content, [METADATA_NAMESPACE_KEY]: _ns, ...rest } = raw;

  return {
    ...rest,
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
    textSearchProvider,
    requireNamespace = false,
    conflictThreshold,
    onConflict,
  } = options;

  if (conflictThreshold !== undefined && conflictThreshold >= deduplicationThreshold) {
    throw new Error(
      `conflictThreshold (${conflictThreshold}) must be less than deduplicationThreshold (${deduplicationThreshold}).`,
    );
  }

  async function embed(text: string): Promise<number[]> {
    const vectors = await embedder([text]);
    return vectors[0]!;
  }

  async function getAllInNamespace(namespace: string): Promise<VectorData[]> {
    const all = await storage.getAll();
    return all.filter((entry) => entry.metadata?.[METADATA_NAMESPACE_KEY] === namespace);
  }

  interface DuplicateCheckResult {
    duplicate: VectorData | undefined;
    conflict: { entry: VectorData; similarity: number } | undefined;
  }

  async function checkDuplicatesAndConflicts(
    vector: number[],
    namespace: string,
  ): Promise<DuplicateCheckResult> {
    const entries = await getAllInNamespace(namespace);
    let duplicate: VectorData | undefined;
    let conflict: { entry: VectorData; similarity: number } | undefined;

    for (const entry of entries) {
      const existingVector = Array.from(entry.vector);
      const similarity = cosineSimilarity(vector, existingVector);

      if (similarity >= deduplicationThreshold) {
        duplicate = entry;
        break; // Exact duplicate takes priority
      }

      if (
        conflictThreshold !== undefined &&
        similarity >= conflictThreshold &&
        similarity < deduplicationThreshold
      ) {
        if (!conflict || similarity > conflict.similarity) {
          conflict = { entry, similarity };
        }
      }
    }

    return { duplicate, conflict };
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
      if (requireNamespace && !metadata?.namespace && defaultNamespace === DEFAULT_NAMESPACE) {
        throw new Error(
          'Namespace is required: provide a namespace in metadata or configure a default namespace.',
        );
      }

      const namespace = metadata?.namespace ?? defaultNamespace;
      const vector = await embed(content);
      const float32Vector = new Float32Array(vector);

      // Check for deduplication and conflicts
      const { duplicate, conflict } = await checkDuplicatesAndConflicts(vector, namespace);

      // Helper to update an existing entry in place (used for dedup and 'replace' conflict)
      async function replaceExisting(existingEntry: VectorData): Promise<MemoryEntry> {
        const now = Date.now();
        const updatedMetadata = buildStorageMetadata(content, namespace, {
          source: 'manual',
          ...metadata,
        });

        await storage.updateMetadata(existingEntry.id, updatedMetadata, {
          merge: false,
          updateTimestamp: true,
        });
        await storage.updateVector(existingEntry.id, float32Vector, {
          updateMagnitude: true,
          updateTimestamp: true,
        });

        if (textSearchProvider) {
          await textSearchProvider.index(existingEntry.id, content, namespace);
        }

        return {
          id: existingEntry.id,
          content,
          vector,
          metadata: {
            namespace,
            source: 'manual',
            ...metadata,
          } as MemoryMetadata,
          createdAt: existingEntry.timestamp,
          updatedAt: now,
        };
      }

      // Deduplication: near-identical entries are updated in place
      if (duplicate) {
        return replaceExisting(duplicate);
      }

      // Conflict detection: topically similar but potentially contradictory
      if (conflict) {
        const existingContent = (conflict.entry.metadata?.[METADATA_CONTENT_KEY] as string) ?? '';
        const existingMeta = parseMemoryMetadata(conflict.entry.metadata ?? {}, namespace);

        const resolution = onConflict
          ? await onConflict(
              { content, metadata: metadata ?? {} },
              {
                id: conflict.entry.id,
                content: existingContent,
                metadata: existingMeta,
                similarity: conflict.similarity,
              },
            )
          : 'keep-both';

        if (resolution === 'replace') {
          return replaceExisting(conflict.entry);
        }

        if (resolution === 'skip') {
          return {
            id: conflict.entry.id,
            content: existingContent,
            vector: Array.from(conflict.entry.vector),
            metadata: existingMeta,
            createdAt: conflict.entry.timestamp,
            updatedAt: conflict.entry.timestamp,
          };
        }

        // 'keep-both' — fall through to normal insert
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

      if (textSearchProvider) {
        await textSearchProvider.index(id, content, namespace);
      }

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

      // When vectorOnly is set, skip BM25 and return pure cosine similarity scores.
      if (mergedOptions.vectorOnly) {
        const vectorScoreById = new Map(vectorResults.map((r) => [r.id, r.score]));

        let results: (MemorySearchResult & { vector?: number[] })[] = candidates
          .map((candidate) => {
            const score = vectorScoreById.get(candidate.id) ?? 0;
            if (score < threshold) return undefined;
            return {
              id: candidate.id,
              content: candidate.content,
              score,
              metadata: parseMemoryMetadata(candidate.metadata, namespace),
              createdAt: candidate.createdAt,
              vector: namespacedEntries.find((e) => e.id === candidate.id)
                ? Array.from(namespacedEntries.find((e) => e.id === candidate.id)!.vector)
                : undefined,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .sort((a, b) => b.score - a.score);

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

        return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
      }

      // Text search — use provider if available, otherwise in-memory BM25.
      let textScores: Map<number, number>;
      if (textSearchProvider) {
        const idScores = await textSearchProvider.search(query, namespace);
        textScores = new Map<number, number>();
        for (let i = 0; i < candidates.length; i++) {
          const score = idScores.get(candidates[i]!.id);
          if (score !== undefined) {
            textScores.set(i, score);
          }
        }
      } else {
        const keywords = extractKeywords(query);
        const documents = candidates.map((candidate) => candidate.content);
        // Pass pre-extracted keywords as queryTerms to avoid double CJK
        // expansion (extractKeywords already produces unigrams + bigrams).
        const rawScores =
          keywords.length > 0
            ? computeBM25Scores(query, documents, { queryTerms: keywords })
            : computeBM25Scores(query, documents);

        // Normalize raw BM25 scores to [0, 1) so they are on the same scale
        // as vector similarity scores and FTS5 normalized scores.
        textScores = new Map<number, number>();
        for (const [index, score] of rawScores) {
          textScores.set(index, score / (1 + score));
        }
      }

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

      // Deduplicate chunks from the same source document, keeping the highest score.
      // After temporal decay and MMR, results may not be sorted by score, so we
      // compare scores explicitly rather than assuming first-seen is best.
      const seenSources = new Map<string, { index: number; score: number }>();
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const sourceDocument = result.metadata[SOURCE_DOCUMENT_KEY] as string | undefined;
        if (!sourceDocument) continue;

        const existing = seenSources.get(sourceDocument);
        if (existing === undefined || result.score > existing.score) {
          seenSources.set(sourceDocument, { index: i, score: result.score });
        }
      }
      const keptIndices = new Set(Array.from(seenSources.values()).map((entry) => entry.index));
      results = results.filter((result, index) => {
        const sourceDocument = result.metadata[SOURCE_DOCUMENT_KEY] as string | undefined;
        if (!sourceDocument) return true;
        return keptIndices.has(index);
      });

      // Final limit and strip vectors from output
      return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
    },

    async list(listOptions?: MemoryListOptions): Promise<MemorySearchResult[]> {
      const namespace = listOptions?.namespace ?? defaultNamespace;
      const limit = listOptions?.limit ?? 100;
      const offset = listOptions?.offset ?? 0;

      const entries = await getAllInNamespace(namespace);

      // Sort by creation time, newest first
      entries.sort((a, b) => b.timestamp - a.timestamp);

      return entries.slice(offset, offset + limit).map((entry) => ({
        id: entry.id,
        content: (entry.metadata?.[METADATA_CONTENT_KEY] as string) ?? '',
        score: 1, // No semantic scoring for list
        metadata: parseMemoryMetadata(entry.metadata ?? {}, namespace),
        createdAt: entry.timestamp,
      }));
    },

    async forget(id: string): Promise<void> {
      await storage.delete(id);
      if (textSearchProvider) {
        await textSearchProvider.remove(id);
      }
    },

    async forgetAll(namespace?: string): Promise<void> {
      const targetNamespace = namespace ?? defaultNamespace;
      const entries = await getAllInNamespace(targetNamespace);
      const ids = entries.map((entry) => entry.id);
      if (ids.length > 0) {
        await storage.deleteMany(ids);
      }
      if (textSearchProvider) {
        await textSearchProvider.clear(targetNamespace);
      }
      // Cascade: clear embedding cache entries for this namespace if the
      // embedder supports namespace-scoped eviction.
      if ('clearNamespace' in embedder && typeof embedder.clearNamespace === 'function') {
        await (embedder as { clearNamespace: (ns: string) => void | Promise<void> }).clearNamespace(
          targetNamespace,
        );
      }
    },

    async count(namespace?: string): Promise<number> {
      const targetNamespace = namespace ?? defaultNamespace;
      const entries = await getAllInNamespace(targetNamespace);
      return entries.length;
    },

    async init(): Promise<void> {
      await storage.init();
      if (textSearchProvider) {
        await textSearchProvider.init();
      }
    },

    async close(): Promise<void> {
      await storage.close();
      if (textSearchProvider) {
        await textSearchProvider.close();
      }
    },
  };

  return memory;
}
