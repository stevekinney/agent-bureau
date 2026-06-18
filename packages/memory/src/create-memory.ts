import type { HybridSearchCandidate, VectorSearchResult } from './hybrid-search';
import { mergeHybridResults } from './hybrid-search';
import { SOURCE_DOCUMENT_KEY } from './ingest';
import { applyMaximalMarginalRelevance } from './maximal-marginal-relevance';
import type { MemoryRecord, MemoryRecordScope } from './memory-record-storage';
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

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Builds the public {@link MemoryMetadata} view of a stored record. The
 * authoritative `namespace` is sourced from the record itself; arbitrary
 * extension keys on the stored metadata are preserved.
 */
function toMemoryMetadata(record: MemoryRecord): MemoryMetadata {
  const raw = record.metadata;
  return {
    ...raw,
    namespace: record.namespace,
    source: (raw['source'] as MemoryMetadata['source']) ?? 'manual',
    conversationId: raw['conversationId'] as string | undefined,
    agentId: raw['agentId'] as string | undefined,
    importance: raw['importance'] as number | undefined,
    evergreen: raw['evergreen'] as boolean | undefined,
    tags: raw['tags'] as string[] | undefined,
  };
}

/**
 * Strips the framework-managed fields from caller-supplied metadata so only
 * extension data is persisted on the record. `namespace` lives on the record's
 * own field, never in the metadata blob.
 */
function buildStoredMetadata(metadata: Partial<MemoryMetadata>): Record<string, unknown> {
  const { namespace: _namespace, ...rest } = metadata;
  return { source: 'manual', ...rest };
}

function toMemoryEntry(record: MemoryRecord, vector?: number[]): MemoryEntry {
  return {
    id: record.id,
    content: record.content,
    vector: vector ?? Array.from(record.vector),
    metadata: toMemoryMetadata(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Creates a Memory instance backed by a {@link CreateMemoryOptions.storage}
 * {@link import('./types').MemoryRecordStorage}.
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

  function scopeFor(namespace: string): MemoryRecordScope {
    // The public contract requires a non-empty namespace; an empty string would
    // otherwise be encoded as a real (but unreachable-by-default) scope key.
    if (namespace.length === 0) {
      throw new Error('namespace must be a non-empty string.');
    }
    return { namespace };
  }

  async function embed(text: string): Promise<number[]> {
    const vectors = await embedder([text]);
    return vectors[0]!;
  }

  interface DuplicateCheckResult {
    duplicate: MemoryRecord | undefined;
    conflict: { record: MemoryRecord; similarity: number } | undefined;
  }

  async function checkDuplicatesAndConflicts(
    vector: number[],
    namespace: string,
  ): Promise<DuplicateCheckResult> {
    // The lowest similarity worth retrieving is whichever floor is active:
    // conflict detection (when enabled) reaches further down than dedup.
    const threshold = conflictThreshold ?? deduplicationThreshold;
    const hits = await storage.searchByVector(vector, scopeFor(namespace), {
      limit: 1,
      threshold,
    });

    const top = hits[0];
    if (!top) return { duplicate: undefined, conflict: undefined };

    if (top.score >= deduplicationThreshold) {
      return { duplicate: top.record, conflict: undefined };
    }

    // Past the dedup check, `conflictThreshold` is necessarily set: if it were
    // undefined the search floor would equal `deduplicationThreshold`, so any
    // returned hit would have scored at or above it and been handled as a
    // duplicate above. The storage contract guarantees `top.score >= threshold`
    // (= `conflictThreshold`), so the top hit — the highest-similarity match
    // below the dedup threshold — is exactly the conflict to surface.
    return { duplicate: undefined, conflict: { record: top.record, similarity: top.score } };
  }

  const memory: Memory = {
    async remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry> {
      if (requireNamespace && !metadata?.namespace && defaultNamespace === DEFAULT_NAMESPACE) {
        throw new Error(
          'Namespace is required: provide a namespace in metadata or configure a default namespace.',
        );
      }

      const namespace = metadata?.namespace ?? defaultNamespace;
      const scope = scopeFor(namespace);
      const vector = await embed(content);
      const float32Vector = new Float32Array(vector);

      const { duplicate, conflict } = await checkDuplicatesAndConflicts(vector, namespace);

      // Update an existing record in place (used for dedup and 'replace' conflict).
      async function replaceExisting(existing: MemoryRecord): Promise<MemoryEntry> {
        const updated = await storage.update(existing.id, scope, {
          content,
          vector: float32Vector,
          metadata: buildStoredMetadata({ source: 'manual', ...metadata }),
        });
        const record = updated ?? existing;

        if (textSearchProvider) {
          await textSearchProvider.index(record.id, content, namespace);
        }

        return toMemoryEntry(record, vector);
      }

      // Deduplication: near-identical entries are updated in place.
      if (duplicate) {
        return replaceExisting(duplicate);
      }

      // Conflict detection: topically similar but potentially contradictory.
      if (conflict) {
        const existingMeta = toMemoryMetadata(conflict.record);

        const resolution = onConflict
          ? await onConflict(
              { content, metadata: metadata ?? {} },
              {
                id: conflict.record.id,
                content: conflict.record.content,
                metadata: existingMeta,
                similarity: conflict.similarity,
              },
            )
          : 'keep-both';

        if (resolution === 'replace') {
          return replaceExisting(conflict.record);
        }

        if (resolution === 'skip') {
          return {
            id: conflict.record.id,
            content: conflict.record.content,
            vector: Array.from(conflict.record.vector),
            metadata: existingMeta,
            createdAt: conflict.record.createdAt,
            updatedAt: conflict.record.updatedAt,
          };
        }

        // 'keep-both' — fall through to normal insert.
      }

      const id = generateId();
      const now = Date.now();
      const record: MemoryRecord = {
        id,
        namespace,
        content,
        vector: float32Vector,
        metadata: buildStoredMetadata({ source: 'manual', ...metadata }),
        createdAt: now,
        updatedAt: now,
        version: 1,
        status: 'active',
      };

      await storage.put(record);

      if (textSearchProvider) {
        await textSearchProvider.index(id, content, namespace);
      }

      return toMemoryEntry(record, vector);
    },

    async rememberOnce(
      content: string,
      metadata: Partial<MemoryMetadata> & { dedupeKey: string },
    ): Promise<MemoryEntry> {
      if (metadata.dedupeKey.length === 0) {
        throw new Error('dedupeKey must be a non-empty string.');
      }

      if (requireNamespace && !metadata.namespace && defaultNamespace === DEFAULT_NAMESPACE) {
        throw new Error(
          'Namespace is required: provide a namespace in metadata or configure a default namespace.',
        );
      }

      const namespace = metadata.namespace ?? defaultNamespace;
      const scope = scopeFor(namespace);
      const existing = await storage.getByDedupeKey?.(scope, metadata.dedupeKey);
      if (existing !== undefined) {
        return toMemoryEntry(existing);
      }

      if (storage.putOnce === undefined) {
        throw new Error('rememberOnce requires storage.putOnce support.');
      }

      const vector = await embed(content);
      const now = Date.now();
      const record: MemoryRecord = {
        id: generateId(),
        namespace,
        content,
        vector: new Float32Array(vector),
        metadata: buildStoredMetadata({ source: 'manual', ...metadata }),
        createdAt: now,
        updatedAt: now,
        version: 1,
        status: 'active',
      };

      const result = await storage.putOnce(record);
      if (result.inserted && textSearchProvider) {
        await textSearchProvider.index(record.id, content, namespace);
      }

      return toMemoryEntry(result.record, result.inserted ? vector : undefined);
    },

    async recall(
      query: string,
      searchOptions?: MemorySearchOptions,
    ): Promise<MemorySearchResult[]> {
      const mergedOptions = { ...defaultSearchOptions, ...searchOptions };
      const namespace = mergedOptions.namespace ?? defaultNamespace;
      const scope = scopeFor(namespace);
      const limit = mergedOptions.limit ?? 10;
      const threshold = mergedOptions.threshold ?? 0;
      const vectorWeight = mergedOptions.vectorWeight ?? 0.7;
      const textWeight = mergedOptions.textWeight ?? 0.3;

      const queryVector = await embed(query);
      const candidateMultiplier = 3;
      const vectorResultLimit = limit * candidateMultiplier;

      // When vectorOnly is set, skip BM25 and return pure cosine similarity
      // scores filtered by the (cosine-semantics) threshold.
      if (mergedOptions.vectorOnly) {
        const hits = await storage.searchByVector(queryVector, scope, {
          limit: vectorResultLimit,
          threshold,
        });

        let results: (MemorySearchResult & { vector?: number[] })[] = hits.map((hit) => ({
          id: hit.id,
          content: hit.record.content,
          score: hit.score,
          metadata: toMemoryMetadata(hit.record),
          createdAt: hit.record.createdAt,
          vector: Array.from(hit.record.vector),
        }));

        if (mergedOptions.temporalDecay) {
          results = applyTemporalDecay(results, {
            halfLifeMilliseconds: mergedOptions.temporalDecay.halfLifeMilliseconds,
            evergreenExempt: mergedOptions.temporalDecay.evergreenExempt ?? true,
          });
        }

        if (mergedOptions.diversify) {
          results = applyMaximalMarginalRelevance(results, limit, {
            lambda: mergedOptions.diversify.lambda,
          });
        }

        return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
      }

      // Hybrid path: enumerate the scoped corpus for BM25, run vector search
      // through storage, then merge.
      const corpus = await storage.list(scope);
      if (corpus.length === 0) return [];

      const recordsById = new Map(corpus.map((record) => [record.id, record]));
      const candidates: HybridSearchCandidate[] = corpus.map((record) => ({
        id: record.id,
        content: record.content,
        metadata: record.metadata,
        createdAt: record.createdAt,
      }));

      // Vector similarity search — no threshold here: the recall threshold is
      // applied to the COMBINED score by mergeHybridResults. Pre-filtering the
      // vector half would discard valid hybrid matches.
      const vectorHits = await storage.searchByVector(queryVector, scope, {
        limit: vectorResultLimit,
      });
      const vectorResults: VectorSearchResult[] = vectorHits.map((hit) => ({
        id: hit.id,
        score: hit.score,
      }));

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
        // as vector similarity scores.
        textScores = new Map<number, number>();
        for (const [index, score] of rawScores) {
          textScores.set(index, score / (1 + score));
        }
      }

      // Merge hybrid results.
      const hybridResults = mergeHybridResults(vectorResults, textScores, candidates, {
        vectorWeight,
        textWeight,
        limit: limit * candidateMultiplier,
        threshold,
      });

      // Convert to MemorySearchResult with vectors for MMR.
      let results: (MemorySearchResult & { vector?: number[] })[] = hybridResults.map((result) => {
        const matched = recordsById.get(result.id);
        return {
          id: result.id,
          content: result.content,
          score: result.combinedScore,
          metadata: matched
            ? toMemoryMetadata(matched)
            : ({ ...result.metadata, namespace } as MemoryMetadata),
          createdAt: result.createdAt,
          vector: matched ? Array.from(matched.vector) : undefined,
        };
      });

      // Apply temporal decay if configured.
      if (mergedOptions.temporalDecay) {
        results = applyTemporalDecay(results, {
          halfLifeMilliseconds: mergedOptions.temporalDecay.halfLifeMilliseconds,
          evergreenExempt: mergedOptions.temporalDecay.evergreenExempt ?? true,
        });
      }

      // Apply MMR for diversity if configured.
      if (mergedOptions.diversify) {
        results = applyMaximalMarginalRelevance(results, limit, {
          lambda: mergedOptions.diversify.lambda,
        });
      }

      // Deduplicate chunks from the same source document, keeping the highest
      // score. After temporal decay and MMR, results may not be sorted by
      // score, so we compare scores explicitly rather than assuming first-seen
      // is best.
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

      // Final limit and strip vectors from output.
      return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
    },

    async list(listOptions?: MemoryListOptions): Promise<MemorySearchResult[]> {
      const namespace = listOptions?.namespace ?? defaultNamespace;
      const limit = listOptions?.limit ?? 100;
      const offset = listOptions?.offset ?? 0;

      // Storage returns records newest-first; pagination is pushed down.
      const records = await storage.list(scopeFor(namespace), { limit, offset });

      return records.map((record) => ({
        id: record.id,
        content: record.content,
        score: 1, // No semantic scoring for list.
        metadata: toMemoryMetadata(record),
        createdAt: record.createdAt,
      }));
    },

    async forget(id: string, namespace?: string): Promise<void> {
      const removed = await storage.delete(id, scopeFor(namespace ?? defaultNamespace));
      // Only strip the text-index entry if the scoped delete actually removed the
      // record. `textSearchProvider.remove(id)` is keyed by bare id while
      // `storage.delete` is scope-keyed, so an unmatched-namespace forget must NOT
      // evict the index entry of the record still living under its real scope.
      if (removed && textSearchProvider) {
        await textSearchProvider.remove(id);
      }
    },

    async forgetAll(namespace?: string): Promise<void> {
      const targetNamespace = namespace ?? defaultNamespace;
      await storage.deleteNamespace(scopeFor(targetNamespace));
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
      return storage.count(scopeFor(namespace ?? defaultNamespace));
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
